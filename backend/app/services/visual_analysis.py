"""On-demand single-frame extraction and multimodal analysis for LectureMate."""
from __future__ import annotations

import base64
import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import HTTPException


def _ffmpeg_path() -> str:
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail="Video frame tools are unavailable. In the backend environment run: python -m pip install -r requirements.txt, then restart the backend.",
        ) from exc


def extract_youtube_frame(video_url: str, seconds: int) -> str:
    """Fetch only a single requested frame from a YouTube stream when possible."""
    try:
        import yt_dlp
    except Exception as exc:
        raise HTTPException(status_code=500, detail="YouTube frame extraction requires yt-dlp. Install backend requirements and restart.") from exc

    try:
        # YouTube's available formats vary by video, region, and extractor version.
        # Try tolerant selectors instead of assuming a <=480p combined format exists.
        info = None
        selector_errors = []
        # Some YouTube videos expose only adaptive video streams or omit the
        # usual combined MP4 formats. Include low-resolution fallbacks so a
        # single-frame capture can still work when a preferred format is absent.
        format_selectors = (
            "bestvideo*+bestaudio/best/worstvideo/worst",
            "bestvideo/best/worstvideo/worst",
            "best[ext=mp4]/best/worst",
            "worstvideo/worst",
        )
        # Optional auth settings. Prefer explicit environment configuration, but
        # also retry a bot challenge with locally available browser cookies. This
        # runs only in the backend user's account; no cookies are uploaded/stored.
        cookie_file = os.getenv("LECTUREMATE_YTDLP_COOKIES_FILE", "").strip()
        browser_setting = os.getenv("LECTUREMATE_YTDLP_COOKIES_FROM_BROWSER", "").strip()
        auth_modes = [None]
        if cookie_file:
            auth_modes.append({"cookiefile": cookie_file})
        if browser_setting:
            browser_name, _, profile = browser_setting.partition(":")
            browser_name = browser_name.strip().lower()
            if browser_name in {"chrome", "edge", "firefox", "brave", "opera", "chromium", "vivaldi"}:
                auth_modes.append({"cookiesfrombrowser": (browser_name, profile.strip() or None)})
        # If YouTube explicitly challenges unauthenticated requests, try Chrome
        # and Edge cookies as a convenience; browser DB locks can still prevent it.
        auth_modes.extend([
            {"cookiesfrombrowser": ("chrome",)},
            {"cookiesfrombrowser": ("edge",)},
        ])
        seen_auth = set()
        auth_modes = [mode for mode in auth_modes if not (repr(mode) in seen_auth or seen_auth.add(repr(mode)))]
        bot_challenge_seen = False
        for format_selector in format_selectors:
            for auth_mode in auth_modes:
                # Don't touch browser profiles unless unauthenticated extraction was
                # blocked, unless the user explicitly configured cookie access.
                if auth_mode and not bot_challenge_seen and not cookie_file and not browser_setting:
                    continue
                try:
                    options = {
                        "format": format_selector,
                        "noplaylist": True,
                        "quiet": True,
                        "no_warnings": True,
                        "socket_timeout": 25,
                        "extractor_retries": 2,
                        "fragment_retries": 2,
                        "format_sort": ["res:480", "codec:h264"],
                    }
                    if auth_mode:
                        options.update(auth_mode)
                    with yt_dlp.YoutubeDL(options) as ydl:
                        info = ydl.extract_info(video_url, download=False)
                    if info and (info.get("url") or info.get("requested_formats") or info.get("formats")):
                        break
                except Exception as selector_exc:
                    error_text = str(selector_exc)
                    selector_errors.append(error_text)
                    if any(term in error_text.lower() for term in ("sign in to confirm", "not a bot", "confirm you’re not a bot", "confirm you're not a bot")):
                        bot_challenge_seen = True
                    info = None
            if info:
                break
        if not info:
            raise RuntimeError(selector_errors[-1] if selector_errors else "YouTube did not return a usable video format.")
        formats = info.get("requested_formats") or info.get("formats") or [info]
        candidates = [item for item in formats if item.get("url") and item.get("vcodec", "none") != "none"]
        if not candidates and info.get("url"):
            candidates = [info]
        if not candidates:
            raise RuntimeError("No playable video stream was returned by YouTube.")
        # Prefer a combined stream if available to avoid unnecessary DASH complexity.
        candidates.sort(key=lambda item: (item.get("acodec", "none") != "none", item.get("height") or 0), reverse=True)
        stream = candidates[0]
        stream_url = stream["url"]
        headers = stream.get("http_headers") or info.get("http_headers") or {}
        header_blob = "".join(f"{key}: {value}\r\n" for key, value in headers.items())
        command = [_ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-ss", str(max(0, seconds))]
        if header_blob:
            command.extend(["-headers", header_blob])
        command.extend([
            "-i", stream_url, "-frames:v", "1", "-vf", "scale=1024:-1",
            "-q:v", "5", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
        ])
        result = subprocess.run(command, capture_output=True, timeout=45, check=False)
        if result.returncode != 0 or not result.stdout:
            error = result.stderr.decode("utf-8", errors="replace")[-240:]
            raise RuntimeError(error or "FFmpeg could not read the current video frame.")
        return base64.b64encode(result.stdout).decode("ascii")
    except HTTPException:
        raise
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="Timed out while capturing this YouTube frame. Try again or pause at a different timestamp.") from exc
    except Exception as exc:
        message = str(exc)
        if any(term in message.lower() for term in ("sign in to confirm", "not a bot", "confirm you’re not a bot", "confirm you're not a bot")):
            message = (
                "YouTube blocked frame extraction with its sign-in/bot check. Sign in to YouTube in Chrome or Edge, "
                "close that browser completely, then retry. If automatic browser-cookie access is unavailable, set "
                "LECTUREMATE_YTDLP_COOKIES_FROM_BROWSER=chrome (or edge) in the backend environment and restart it. "
                "Only use cookies for an account/video you are authorized to access."
            )
        raise HTTPException(status_code=502, detail=f"Could not capture the YouTube frame at {seconds}s: {message[:420]}") from exc


def analyze_image(image_base64: str, title: str, seconds: int, settings: dict[str, Any]) -> tuple[str, str]:
    """Send one user-requested screenshot to the configured vision model."""
    try:
        image_bytes = base64.b64decode(image_base64, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=422, detail="The screenshot data is invalid. Capture the frame again and retry.") from exc
    if not image_bytes or len(image_bytes) > 8 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Screenshot is empty or too large. Try again with a smaller frame.")

    prompt = (
        f"You are LectureMate, a careful visual tutor. Analyze this single screenshot from the lecture '{title}' "
        f"at video timestamp {seconds // 60:02d}:{seconds % 60:02d}. Explain what is visibly present, focusing on slide text, "
        "equations, diagrams, charts, code, labels, and relationships that can be supported by the image. "
        "If text is blurry or cropped, say so instead of guessing. Do not claim to know what was said aloud. "
        "Use concise headings and bullets. If useful, explain the visible concept using general knowledge, but distinguish that explanation from what the screenshot proves."
    )
    provider = settings.get("provider", "ollama")
    if provider == "gemini":
        api_key = settings.get("gemini_api_key")
        if not api_key:
            import os
            api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
        if not api_key:
            raise HTTPException(status_code=400, detail="Gemini is selected, but no API key is configured. Open AI model settings and add your key.")
        try:
            from google import genai
            from google.genai import types
            client = genai.Client(api_key=api_key)
            response = client.models.generate_content(
                model=settings.get("gemini_model", "gemini-flash-latest"),
                contents=[prompt, types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg")],
            )
            answer = (response.text or "").strip()
            if not answer:
                raise RuntimeError("Gemini returned an empty visual analysis.")
            return answer, "gemini"
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Gemini screenshot analysis failed: {str(exc)[:260]}") from exc

    model = (settings.get("ollama_vision_model") or "qwen2.5vl:3b").strip()
    base_url = settings.get("ollama_base_url", "http://127.0.0.1:11434").rstrip("/")
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt, "images": [image_base64]}],
        "stream": False,
        "options": {"temperature": 0.2, "num_ctx": 4096},
    }).encode("utf-8")
    request = Request(f"{base_url}/api/chat", data=payload, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urlopen(request, timeout=180) as response:
            result = json.loads(response.read().decode("utf-8"))
        answer = (result.get("message", {}).get("content") or "").strip()
        if not answer:
            raise RuntimeError("Ollama returned an empty screenshot analysis.")
        return answer, f"ollama ({model})"
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:350]
        if "not found" in detail.lower() or "pull model" in detail.lower():
            detail = f"Ollama could not find vision model '{model}'. In PowerShell run: ollama pull {model}"
        raise HTTPException(status_code=502, detail=f"Ollama screenshot analysis failed: {detail}") from exc
    except (URLError, TimeoutError) as exc:
        raise HTTPException(status_code=502, detail="Could not connect to Ollama. Check that Ollama is running at the configured server URL.") from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Ollama screenshot analysis failed: {str(exc)[:260]}") from exc


def extract_local_frame(video_path: Path, seconds: int) -> str:
    """Extract one frame from an uploaded local video as a fallback for browser capture."""
    if not video_path.is_file():
        raise HTTPException(status_code=404, detail="The uploaded video file could not be found.")
    command = [
        _ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-ss", str(max(0, seconds)),
        "-i", str(video_path), "-frames:v", "1", "-vf", "scale=1024:-1", "-q:v", "5",
        "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
    ]
    try:
        result = subprocess.run(command, capture_output=True, timeout=30, check=False)
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="Timed out while capturing this frame. Try another timestamp.") from exc
    if result.returncode != 0 or not result.stdout:
        raise HTTPException(status_code=422, detail="Could not capture this frame from the uploaded video. Try another timestamp.")
    return base64.b64encode(result.stdout).decode("ascii")
