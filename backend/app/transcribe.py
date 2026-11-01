"""What is said in a video, with times: the Ad Studio's listener uses it for the best moments and the subtitles.

Meta Muse Voice Transcribe first (wss://api.meta.ai/v1/asr/realtime): the audio goes as PCM16 16 kHz binary frames, paced a
few seconds ahead of what the server has processed, in ENDPOINTING mode so every spoken turn comes back with its start and end
(`speechStart` / `speechComplete`, in ms of audio). Muse gives turn-level times, not word-level ones: the words of a turn are
spread over it in proportion to their length. Without a Meta key, Whisper through Groq or OpenAI (word timestamps).

Result: [{"start": s, "end": s, "text": "...", "words": [{"w", "t", "d"}]}] with times in seconds.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path

import httpx

from . import keystore, media
from .providers import PROVIDERS

log = logging.getLogger("arena.transcribe")

MUSE_URL = "wss://api.meta.ai/v1/asr/realtime"
MUSE_MODEL = "muse-voice-transcribe-1.0"
RATE = 16000
FRAME = RATE * 2 * 80 // 1000  # 80 ms of PCM16 mono
AHEAD_MS = 3500  # Muse rejects audio more than 5 s ahead of what it has processed


def spread(start: float, end: float, text: str) -> list[dict]:
    """Word times for a turn that only has its start and end: in proportion to each word's length."""
    words = text.split()
    if not words:
        return []
    weights = [len(w) + 2 for w in words]
    total, t, out = sum(weights), start, []
    for w, k in zip(words, weights):
        d = (end - start) * k / total
        out.append({"w": w, "t": round(t, 2), "d": round(d, 2)})
        t += d
    return out


def who(user_id: str) -> str | None:
    creds = keystore.creds(user_id)
    for pid in ("meta", "groq", "openai"):
        c = creds.get(pid)
        if c and c.source != "none" and c.api_key:
            return pid
    return None


def keywords(text: str) -> list[str]:
    """Names and acronyms from the user's own words (product, brand, places) to bias the transcriber, e.g. «SICOP»."""
    out: list[str] = []
    for w in re.findall(r"\b[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ-]{2,}\b", text or ""):
        if w not in out and w.lower() not in ("que", "para", "con", "the", "and", "una", "los", "las"):
            out.append(w)
    return out[:20]


async def _muse(key: str, audio: bytes, words: list[str]) -> list[dict]:
    import websockets

    segs: dict[int, dict] = {}
    async with websockets.connect(MUSE_URL, max_size=1 << 22, open_timeout=15) as ws:
        hello = {"authorization": {"accessToken": f"Bearer {key}"}, "audioEncoding": "PCM_16KHZ", "model": MUSE_MODEL, "mode": "ENDPOINTING", "emitAudioProgress": True}
        if words:  # the language is detected by Muse itself: the interface language is not the video's
            hello["keywords"] = words
        await ws.send(json.dumps(hello))
        ack = json.loads(await asyncio.wait_for(ws.recv(), 10))
        if "sessionId" not in ack:
            raise RuntimeError(ack.get("message") or "Muse no aceptó la conexión")
        processed = 0

        async def reader():
            nonlocal processed
            async for msg in ws:
                if isinstance(msg, bytes):
                    continue
                ev = json.loads(msg)
                processed = max(processed, int(ev.get("audioProcessedMs") or 0))
                kind = ev.get("type")
                if kind == "speechStart":
                    segs[ev["turnId"]] = {"start": ev["audioProcessedMs"] / 1000, "end": None, "text": ""}
                elif kind == "speechComplete":
                    s = segs.setdefault(ev["turnId"], {"start": max(0, ev["audioProcessedMs"] / 1000 - 3), "text": ""})
                    s["end"], s["text"] = ev["audioProcessedMs"] / 1000, ev.get("transcript") or ""
                elif kind == "error":
                    raise RuntimeError(ev.get("message") or "error de Muse")

        task = asyncio.create_task(reader())
        sent = 0
        for i in range(0, len(audio), FRAME):
            while sent - processed > AHEAD_MS and not task.done():
                await asyncio.sleep(0.04)
            if task.done():
                break
            await ws.send(audio[i:i + FRAME])
            sent += 80
        await ws.send(json.dumps({"type": "endStream"}))
        try:
            await asyncio.wait_for(task, timeout=60)
        except (asyncio.TimeoutError, Exception) as e:  # noqa: BLE001 — the server closes with 1000 when done
            if task.done() and task.exception() and not isinstance(task.exception(), websockets.ConnectionClosedOK):
                raise task.exception()  # type: ignore[misc]
            if isinstance(e, asyncio.TimeoutError):
                task.cancel()
    out = []
    for s in sorted(segs.values(), key=lambda x: x["start"]):
        if (s.get("text") or "").strip():
            end = s.get("end") or s["start"] + max(1.0, len(s["text"]) / 14)
            out.append({"start": round(s["start"], 2), "end": round(end, 2), "text": s["text"].strip(), "words": spread(s["start"], end, s["text"].strip())})
    return out


async def _whisper(pid: str, key: str, wav: Path, language: str) -> list[dict]:
    base = PROVIDERS[pid].base_url or "https://api.openai.com/v1"
    model = "whisper-large-v3-turbo" if pid == "groq" else "whisper-1"
    lang = {"español": "es", "spanish": "es", "english": "en", "inglés": "en", "português": "pt", "portugués": "pt"}.get(language.split()[0].lower(), "") if language else ""
    data = [("model", model), ("response_format", "verbose_json"), ("timestamp_granularities[]", "word"), ("timestamp_granularities[]", "segment")] + ([("language", lang)] if lang else [])
    async with httpx.AsyncClient(timeout=600) as cx:
        r = await cx.post(f"{base.rstrip('/')}/audio/transcriptions", headers={"Authorization": f"Bearer {key}"}, data=data, files={"file": ("audio.wav", wav.read_bytes(), "audio/wav")})
    if r.status_code >= 400:
        raise RuntimeError(f"La transcripción falló ({r.status_code}): {r.text[:200]}")
    j = r.json()
    words = [{"w": w["word"].strip(), "t": round(w["start"], 2), "d": round(max(0.08, w["end"] - w["start"]), 2)} for w in j.get("words") or [] if w.get("word", "").strip()]
    out = []
    for s in j.get("segments") or [{"start": 0, "end": j.get("duration") or 0, "text": j.get("text") or ""}]:
        ws = [w for w in words if s["start"] - 0.05 <= w["t"] < s["end"]] or spread(s["start"], s["end"], s["text"].strip())
        if s["text"].strip():
            out.append({"start": round(s["start"], 2), "end": round(s["end"], 2), "text": s["text"].strip(), "words": ws})
    return out


async def transcribe(user_id: str, video: Path, work: Path, language: str = "", keywords: list[str] | None = None) -> tuple[list[dict], str | None]:
    """(segments, «who listened») — ([], None) when the video has no voice or there is no transcriber key."""
    pid = who(user_id)
    if not pid:
        return [], None
    key = keystore.creds(user_id)[pid].api_key or ""
    work.mkdir(parents=True, exist_ok=True)
    if pid == "meta":
        raw = work / f"{video.stem}.pcm"
        if not await asyncio.to_thread(media.pcm, video, raw, RATE):
            return [], "Meta · Muse Voice Transcribe"
        return await _muse(key, raw.read_bytes(), keywords or []), "Meta · Muse Voice Transcribe"
    wav = work / f"{video.stem}.wav"
    if not await asyncio.to_thread(media.wav, video, wav):
        return [], None
    return await _whisper(pid, key, wav, language), f"{PROVIDERS[pid].label} · Whisper"
