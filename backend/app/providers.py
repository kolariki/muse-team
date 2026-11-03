"""Unified streaming layer over every LLM vendor.

Every provider exposes the same thing: `stream(...)` yields `(kind, text)` chunks where kind is
"text" (visible answer) or "reasoning" (native chain-of-thought, e.g. deepseek-reasoner), and fills
a `CallResult` with usage + timings once the stream ends.

Most vendors speak the OpenAI wire protocol, so they share one client with a different base_url.
Anthropic uses its own SDK. "mock" is a zero-cost fake that lets you demo/record without keys.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import random
import re
import time
from dataclasses import dataclass, field
from typing import AsyncIterator

from anthropic import AsyncAnthropic
from openai import AsyncOpenAI

from .config import env


@dataclass
class ProviderSpec:
    id: str
    label: str
    color: str
    key_env: str | None
    base_url: str | None
    default_model: str
    kind: str = "openai"  # openai | anthropic | mock

    @property
    def api_key(self) -> str | None:
        if self.kind == "mock":
            return "mock"
        if self.id == "ollama":
            return "ollama" if env("OLLAMA_BASE_URL") else None
        return env(self.key_env) if self.key_env else None

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    @property
    def model(self) -> str:
        return env(f"DEFAULT_MODEL_{self.id.upper()}", self.default_model) or self.default_model


PROVIDERS: dict[str, ProviderSpec] = {
    p.id: p
    for p in [
        ProviderSpec("meta", "Meta · Muse", "#0082FB", "META_API_KEY", "https://api.meta.ai/v1", "muse-spark-1.3"),
        ProviderSpec("anthropic", "Anthropic · Claude", "#C0603F", "ANTHROPIC_API_KEY", None, "claude-sonnet-5-5", "anthropic"),
        ProviderSpec("openai", "OpenAI · GPT", "#17896A", "OPENAI_API_KEY", None, "gpt-5-mini"),
        ProviderSpec("deepseek", "DeepSeek", "#3D5CC4", "DEEPSEEK_API_KEY", "https://api.deepseek.com", "deepseek-chat"),
        ProviderSpec("gemini", "Google · Gemini", "#9A57B8", "GEMINI_API_KEY", "https://generativelanguage.googleapis.com/v1beta/openai/", "gemini-3.8-flash"),
        ProviderSpec("xai", "xAI · Grok", "#4B5157", "XAI_API_KEY", "https://api.x.ai/v1", "grok-4"),
        ProviderSpec("groq", "Groq · Llama", "#C24B6E", "GROQ_API_KEY", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"),
        ProviderSpec("kimi", "Moonshot · Kimi", "#1F3A68", "KIMI_API_KEY", env("KIMI_BASE_URL", "https://api.moonshot.ai/v1"), "kimi-k2.6"),
        ProviderSpec("mistral", "Mistral", "#AD7D1A", "MISTRAL_API_KEY", "https://api.mistral.ai/v1", "mistral-medium-latest"),
        ProviderSpec("openrouter", "OpenRouter", "#1689A8", "OPENROUTER_API_KEY", "https://openrouter.ai/api/v1", "qwen/qwen3-235b-a22b"),
        ProviderSpec("baseten", "Baseten · open models", "#111111", "BASETEN_API_KEY", "https://inference.baseten.co/v1", "zai-org/GLM-5.3"),
        ProviderSpec("ollama", "Ollama (local)", "#6E8226", None, None, "llama3.2"),
        ProviderSpec("mock", "Simulado (sin API)", "#8A9299", None, None, "mock-1", "mock"),
    ]
}


CACHE_SEP = "\x1e"  # splits a system prompt into cacheable blocks (shared project context | role text)


@dataclass
class CallResult:
    input_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0
    ttft_ms: float | None = None
    latency_ms: float = 0.0
    started_at: float = field(default_factory=time.time)
    first_token_at: float | None = None
    estimated_usage: bool = False
    truncated: bool = False  # output hit max_tokens
    cached_input_tokens: int = 0  # read from the provider's prompt cache (≈10% of the input price)
    cache_write_tokens: int = 0  # written to the cache this call (Anthropic bills 1.25×)


@dataclass
class MockContext:
    """Hints the mock provider uses to produce a plausible tagged answer."""
    self_name: str
    others: list[tuple[str, str]]  # (id, name)
    topic: str
    vote: bool = False
    script: str | None = None  # stream this exact text (used for the mock judge)


@dataclass(frozen=True)
class Cred:
    """Resolved credentials for one provider: the user's own key, or the server's .env key."""
    api_key: str | None
    base_url: str | None = None
    model: str | None = None
    source: str = "none"  # user | server | none


def server_cred(provider: str) -> Cred:
    spec = PROVIDERS[provider]
    base = env("OLLAMA_BASE_URL", "http://localhost:11434/v1") if provider == "ollama" else spec.base_url
    return Cred(spec.api_key, base, spec.model, "server" if spec.api_key else "none")


_openai_clients: dict[tuple, AsyncOpenAI] = {}
_anthropic_clients: dict[str, AsyncAnthropic] = {}


def _openai_client(spec: ProviderSpec, cred: Cred) -> AsyncOpenAI:
    k = (spec.id, cred.api_key, cred.base_url)
    if k not in _openai_clients:
        _openai_clients[k] = AsyncOpenAI(api_key=cred.api_key or "none", base_url=cred.base_url or spec.base_url, timeout=120)
    return _openai_clients[k]


def _anthropic(cred: Cred) -> AsyncAnthropic:
    if cred.api_key not in _anthropic_clients:
        _anthropic_clients[cred.api_key or ""] = AsyncAnthropic(api_key=cred.api_key, timeout=120)
    return _anthropic_clients[cred.api_key or ""]


def _is_reasoning_openai_model(model: str) -> bool:
    m = model.lower()
    return m.startswith(("gpt-5", "o1", "o3", "o4", "gpt-6"))


async def stream(
    provider: str,
    model: str,
    system: str,
    user: str,
    *,
    temperature: float,
    max_tokens: int,
    result: CallResult,
    mock: MockContext | None = None,
    cred: Cred | None = None,
    history: list[dict] | None = None,
    images: list[bytes] | None = None,
) -> AsyncIterator[tuple[str, str]]:
    """`history`: prior {role: user|assistant, content} turns inserted between the system prompt and `user`.
    `images`: PNG screenshots attached to the user turn (vision models: Anthropic and OpenAI-compatible vendors)."""
    spec = PROVIDERS[provider]
    cred = cred or server_cred(provider)
    history = history or []
    t0 = time.perf_counter()

    def mark_first():
        if result.ttft_ms is None:
            result.ttft_ms = (time.perf_counter() - t0) * 1000
            result.first_token_at = time.time()

    if spec.kind == "mock":
        if model == "mock-503":  # simulated outage, for testing the pause / switch-model flow
            raise RuntimeError("Error code: 503 - {'error': {'code': 503, 'message': 'This model is currently experiencing high demand (simulado). Please try again later.', 'status': 'UNAVAILABLE'}}")
        if model == "mock-400":  # simulated account error (no credits), for testing the pause / switch-model flow
            raise RuntimeError("Error code: 400 - {'type': 'error', 'error': {'type': 'invalid_request_error', 'message': 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits. (simulado)'}}")
        gen = _mock_stream(mock, result)
    elif spec.kind == "anthropic":
        gen = _anthropic_stream(cred, model, system, user, temperature, max_tokens, result, history, images or [])
    else:
        gen = _openai_stream(spec, cred, model, system, user, temperature, max_tokens, result, history, images or [])

    out_chars = 0
    async for kind, text in gen:
        if text:
            mark_first()
            out_chars += len(text)
            yield kind, text

    result.latency_ms = (time.perf_counter() - t0) * 1000
    if not result.output_tokens:
        result.estimated_usage = True
        result.output_tokens = max(1, out_chars // 4)
    if not result.input_tokens:
        result.estimated_usage = True
        result.input_tokens = (len(system) + len(user)) // 4


async def _openai_stream(spec, cred, model, system, user, temperature, max_tokens, result, history=(), images=()) -> AsyncIterator[tuple[str, str]]:
    system = system.replace(CACHE_SEP, "\n\n")  # same prefix for every call → OpenAI-style automatic prefix caching
    client = _openai_client(spec, cred)
    content: str | list = user
    if images:
        content = [*({"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(im).decode()}} for im in images), {"type": "text", "text": user}]
    kwargs: dict = dict(
        model=model,
        messages=[{"role": "system", "content": system}, *history, {"role": "user", "content": content}],
        stream=True,
    )
    if spec.id == "openai" and _is_reasoning_openai_model(model):
        # Reasoning models reject temperature and count hidden reasoning against the token budget.
        kwargs["max_completion_tokens"] = max_tokens * 4
        kwargs["reasoning_effort"] = env("OPENAI_REASONING_EFFORT", "low")
    else:
        kwargs["max_tokens"] = max_tokens
        kwargs["temperature"] = temperature
    if spec.id in ("openai", "deepseek", "xai", "groq", "openrouter", "gemini", "mistral", "kimi"):
        kwargs["stream_options"] = {"include_usage": True}

    try:
        resp = await client.chat.completions.create(**kwargs)
    except Exception as e:  # some vendors reject stream_options / reasoning_effort: retry plain
        if "stream_options" in kwargs or "reasoning_effort" in kwargs:
            kwargs.pop("stream_options", None)
            kwargs.pop("reasoning_effort", None)
            resp = await client.chat.completions.create(**kwargs)
        else:
            raise e

    async for chunk in resp:
        if getattr(chunk, "usage", None):
            u = chunk.usage
            result.input_tokens = u.prompt_tokens or 0
            result.output_tokens = u.completion_tokens or 0
            details = getattr(u, "completion_tokens_details", None)
            result.reasoning_tokens = (getattr(details, "reasoning_tokens", 0) or 0) if details else 0
        if not chunk.choices:
            continue
        if getattr(chunk.choices[0], "finish_reason", None) == "length":
            result.truncated = True
        delta = chunk.choices[0].delta
        reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
        if reasoning:
            yield "reasoning", reasoning
        if delta.content:
            yield "text", delta.content


# tokens reserved for the model's (low-effort) thinking on top of the message budget, so the message is never squeezed out
THINKING_HEADROOM = 2048


async def _anthropic_stream(cred, model, system, user, temperature, max_tokens, result, history=(), images=()) -> AsyncIterator[tuple[str, str]]:
    client = _anthropic(cred)
    content: str | list = user
    if images:
        content = [*({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": base64.b64encode(im).decode()}} for im in images), {"type": "text", "text": user}]
    # The system prompt may come as several blocks separated by CACHE_SEP: a big shared block (the project under review,
    # identical for every role and turn) first, role-specific text after. Each block gets a cache breakpoint, so repeated
    # calls read it from Anthropic's prompt cache at ~10% of the input price instead of paying for 20k+ tokens every turn.
    blocks = [b for b in system.split(CACHE_SEP) if b.strip()] or [system]
    sys_blocks = [{"type": "text", "text": b, "cache_control": {"type": "ephemeral"}} for b in blocks[:4]]
    # anthropic>=1.13 dropped `temperature` (Claude 5 models don't take it); it is ignored here.
    # Claude 5 models think by default and that thinking counts against `max_tokens`: a 900-token turn came back as
    # 900 tokens of reasoning and an empty message. They also reject `thinking.type.disabled` (HTTP 400: "use
    # thinking.type.adaptive and output_config.effort"), so the right call is adaptive thinking at low effort, with
    # headroom on top of the message budget so the answer itself is never cut. Older models that do not know
    # `output_config` get the plain call; `disabled` stays as a last resort for models that accept it.
    headroom = max_tokens + THINKING_HEADROOM
    kwargs = dict(model=model, system=sys_blocks, max_tokens=max_tokens, messages=[*history, {"role": "user", "content": content}])
    attempts = [
        dict(kwargs, max_tokens=headroom, thinking={"type": "adaptive"}, output_config={"effort": "low"}),
        dict(kwargs, thinking={"type": "disabled"}),
        kwargs,
    ]
    for i, kw in enumerate(attempts):
        try:
            async with client.messages.stream(**kw) as s:
                async for event in s:
                    et = getattr(event, "type", "")
                    if et == "content_block_delta":
                        d = event.delta
                        dt = getattr(d, "type", "")
                        if dt == "text_delta" and d.text:
                            yield "text", d.text
                        elif dt == "thinking_delta" and getattr(d, "thinking", ""):
                            yield "reasoning", d.thinking
                final = await s.get_final_message()
            break
        except Exception as e:  # noqa: BLE001
            msg = str(e).lower()
            if i < len(attempts) - 1 and ("thinking" in msg or "output_config" in msg or "effort" in msg):
                log.info("anthropic %s rejected attempt %d (%s); trying the next variant", model, i, msg[:140])
                continue  # this model does not take the parameter: next variant
            raise
    u = final.usage
    result.cached_input_tokens = int(getattr(u, "cache_read_input_tokens", 0) or 0)
    result.cache_write_tokens = int(getattr(u, "cache_creation_input_tokens", 0) or 0)
    result.input_tokens = int(u.input_tokens) + result.cached_input_tokens + result.cache_write_tokens  # total prompt size
    result.output_tokens = u.output_tokens
    result.truncated = final.stop_reason == "max_tokens"


log = logging.getLogger("arena.providers")

_models_cache: dict[tuple, tuple[float, list[str]]] = {}


async def available_models(provider: str, cred: Cred | None = None, ttl: float = 600) -> list[str] | None:
    """Model ids for this provider/key, cached; None when the provider can't be listed (don't block on it)."""
    cred = cred or server_cred(provider)
    key = (provider, cred.api_key, cred.base_url)
    hit = _models_cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    try:
        models = await asyncio.wait_for(list_models(provider, cred), timeout=15)
    except Exception:
        return None
    _models_cache[key] = (time.time(), models)
    return models


async def list_models(provider: str, cred: Cred | None = None) -> list[str]:
    spec = PROVIDERS[provider]
    if spec.kind == "mock":
        return ["mock-1", "mock-fast", "mock-chaos", "mock-503", "mock-400"]
    cred = cred or server_cred(provider)
    if not cred.api_key and provider != "ollama":
        return []
    if spec.kind == "anthropic":
        page = await _anthropic(cred).models.list(limit=100)
        return [m.id for m in page.data]
    models = await _openai_client(spec, cred).models.list()
    # newest first when the API exposes a creation date, otherwise alphabetical
    data = sorted(models.data, key=lambda m: (-(getattr(m, "created", 0) or 0), m.id))
    ids = list(dict.fromkeys(m.id.removeprefix("models/") for m in data))
    # chat-capable models only: drop embeddings, audio, image and moderation endpoints
    ids = [i for i in ids if not re.search(r"(embed|tts|whisper|transcribe|audio|realtime|live|dall-e|image|imagen|veo|moderation|aqa|search-preview|guard)", i, re.I)]
    if spec.id == "openai":
        ids = [i for i in ids if re.match(r"^(gpt|o\d|chatgpt)", i)]
    if spec.id == "gemini":
        ids = [i for i in ids if i.startswith("gemini")]
    return ids


# --------------------------------------------------------------------------------------------- mock

_MOCK_OPENERS = [
    "Mirá, voy a ser directo:", "Interesante, pero no compro del todo eso.", "Quiero agregar un matiz importante.",
    "Coincido en parte, aunque hay un punto ciego.", "Les propongo darlo vuelta:", "Seamos honestos con los datos:",
]
_MOCK_BODIES = [
    "el problema de {topic} no es técnico sino de incentivos; si no alineamos quién gana y quién pierde, cualquier solución se cae en la primera iteración.",
    "con {topic} hay que separar lo que es medible de lo que es narrativa. Yo arrancaría por un experimento chico, barato y con métricas claras.",
    "sobre {topic}, creo que estamos sobreestimando el corto plazo y subestimando el largo. La segunda derivada es lo que importa.",
    "si miramos {topic} desde el usuario final, la mitad de lo que dijimos no le importa a nadie. Simplifiquemos.",
    "en {topic} veo un riesgo concreto: la complejidad se come el valor. Propongo recortar alcance a la mitad.",
]
_MOCK_STANCES = ["agree", "disagree", "propose", "neutral", "disagree", "propose"]


async def _mock_stream(ctx: MockContext | None, result: CallResult) -> AsyncIterator[tuple[str, str]]:
    ctx = ctx or MockContext("Agente", [("otro", "Otro")], "el tema")
    await asyncio.sleep(random.uniform(0.25, 0.9))  # fake time-to-first-token
    target_id, target_name = random.choice(ctx.others)
    if ctx.script:
        text = ctx.script
    elif ctx.vote:
        text = (
            f"<reflexion>Evalúo quién aportó el argumento más sólido. {target_name} fue el más consistente.</reflexion>\n"
            f"<vote>{target_id}</vote>\n<reason>Fue el único que bajó la discusión a algo accionable.</reason>"
        )
    else:
        topic = ctx.topic[:60]
        stance = random.choice(_MOCK_STANCES)
        text = (
            f"<reflexion>{target_name} todavía no respondió a mi punto clave; quiero ver cómo lo defiende.</reflexion>\n"
            f"<message>{random.choice(_MOCK_OPENERS)} {random.choice(_MOCK_BODIES).format(topic=topic)}</message>\n"
            f"<stance>{stance}</stance>\n<confidence>{random.randint(45, 95)}</confidence>\n"
            f"<next>{target_id}</next>\n<reason>Quiero que {target_name} defienda su postura con un ejemplo concreto.</reason>"
        )
    fast = len(text) > 1500  # long scripted outputs (judge, brief, builder) stream quicker
    for piece in re.findall(r"\S+\s*", text):
        await asyncio.sleep(random.uniform(0.003, 0.010) if fast else random.uniform(0.012, 0.045))
        yield "text", piece
    result.output_tokens = len(text) // 4
