"""Video and audio plumbing for the Ad Studio, with ffmpeg: probe, normalise, extract the audio and grab frames.

ffmpeg comes from the system (the Docker image installs it; on a Mac, Homebrew) or, as a last resort, from the copy
Remotion ships in backend/video/node_modules.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

VIDEO_DIR = Path(__file__).resolve().parents[1] / "video"


def _bin(name: str) -> tuple[str, dict] | None:
    found = shutil.which(name)
    if found:
        return found, dict(os.environ)
    for d in (VIDEO_DIR / "node_modules" / "@remotion").glob("compositor-*"):
        exe = d / name
        if exe.exists():
            env = dict(os.environ)
            env["DYLD_LIBRARY_PATH" if sys.platform == "darwin" else "LD_LIBRARY_PATH"] = str(d)
            return str(exe), env
    return None


def available() -> bool:
    return bool(_bin("ffmpeg") and _bin("ffprobe"))


def run(name: str, args: list[str], timeout: int = 600) -> subprocess.CompletedProcess:
    b = _bin(name)
    if not b:
        raise RuntimeError(f"Falta {name} en el servidor")
    return subprocess.run([b[0], *args], capture_output=True, timeout=timeout, env=b[1])


def probe(path: Path) -> dict:
    """{duration, width, height, audio} of a video (or an image: duration 0)."""
    r = run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", str(path)], 60)
    data = json.loads(r.stdout or b"{}")
    streams = data.get("streams") or []
    v = next((s for s in streams if s.get("codec_type") == "video"), {})
    return {"duration": float((data.get("format") or {}).get("duration") or 0), "width": int(v.get("width") or 0), "height": int(v.get("height") or 0),
            "audio": any(s.get("codec_type") == "audio" for s in streams)}


def normalise(src: Path, out: Path, max_side: int = 1080) -> None:
    """H.264 + AAC at 30 fps, at most 1080 px on the long side: every browser and the renderer can read it, and seeking is fast."""
    scale = f"scale='if(gt(iw,ih),min({max_side},iw),-2)':'if(gt(iw,ih),-2,min({max_side},ih))'"
    r = run("ffmpeg", ["-y", "-v", "error", "-i", str(src), "-vf", f"{scale},fps=30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
                       "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-movflags", "+faststart", str(out)], 1800)
    if r.returncode != 0 or not out.exists():
        raise RuntimeError("No se pudo leer el video: " + (r.stderr or b"").decode("utf-8", "replace")[-300:])


def pcm(src: Path, out: Path, rate: int = 16000) -> bool:
    """The audio as raw PCM16 mono (what the transcriber listens to). False when the video has no sound."""
    r = run("ffmpeg", ["-y", "-v", "error", "-i", str(src), "-vn", "-ac", "1", "-ar", str(rate), "-f", "s16le", str(out)], 600)
    return r.returncode == 0 and out.exists() and out.stat().st_size > rate  # more than half a second


def wav(src: Path, out: Path) -> bool:
    r = run("ffmpeg", ["-y", "-v", "error", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000", str(out)], 600)
    return r.returncode == 0 and out.exists()


def frames(src: Path, out_dir: Path, every: float, limit: int, width: int = 512, prefix: str = "f") -> list[tuple[float, Path]]:
    """One JPEG every `every` seconds (at most `limit`), for the models to look at the footage."""
    out_dir.mkdir(parents=True, exist_ok=True)
    dur = probe(src)["duration"]
    times = [round(i * every + min(0.5, every / 2), 2) for i in range(limit) if i * every < max(dur - 0.2, 0.1)]
    shots = []
    for t in times:
        p = out_dir / f"{prefix}{int(t * 100):06d}.jpg"
        r = run("ffmpeg", ["-y", "-v", "error", "-ss", str(t), "-i", str(src), "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", "4", str(p)], 60)
        if r.returncode == 0 and p.exists():
            shots.append((t, p))
    return shots


def thumb(src: Path, out: Path, at: float = 0.5) -> bool:
    r = run("ffmpeg", ["-y", "-v", "error", "-ss", str(at), "-i", str(src), "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "5", str(out)], 60)
    return r.returncode == 0 and out.exists()
