#!/usr/bin/env python3
"""Small loopback-first OpenAI-compatible Piper TTS sidecar.

The GPL Piper runtime stays in an isolated, downloaded virtual environment and
communicates with the main application over HTTP. Voice assets are downloaded
separately into an ignored cache; no model or runtime is bundled in the repo.
"""

from __future__ import annotations

import argparse
import hmac
import io
import json
import os
from pathlib import Path
import re
import signal
import threading
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Protocol
import unicodedata
import wave


MAX_REQUEST_BYTES = 16 * 1024
MAX_TEXT_CHARACTERS = 600
MAX_INSTRUCTIONS_CHARACTERS = 400
MAX_WAV_BYTES = 4 * 1024 * 1024
REQUEST_TIMEOUT_SECONDS = 12
RATE_LIMIT_REQUESTS = 40
RATE_LIMIT_WINDOW_SECONDS = 60
MODEL_ID = "piper-sv"
LOOPBACK_HOST = "127.0.0.1"
ALLOWED_REQUEST_KEYS = frozenset({"model", "input", "voice", "response_format", "speed", "instructions"})


@dataclass(frozen=True)
class VoiceVariant:
    base_voice: str
    rate_multiplier: float = 1.0
    noise_scale: float = 0.667
    noise_w: float = 0.8


VOICE_VARIANTS: dict[str, VoiceVariant] = {
    "lisa": VoiceVariant("lisa"),
    "lisa-warm": VoiceVariant("lisa", 0.97, 0.61, 0.72),
    "lisa-bright": VoiceVariant("lisa", 1.04, 0.72, 0.86),
    "lisa-calm": VoiceVariant("lisa", 0.92, 0.57, 0.68),
    "lisa-dry": VoiceVariant("lisa", 0.99, 0.6, 0.6),
    "nst": VoiceVariant("nst"),
    "nst-deep": VoiceVariant("nst", 0.9, 0.56, 0.68),
    "nst-calm": VoiceVariant("nst", 0.94, 0.59, 0.71),
    "nst-dry": VoiceVariant("nst", 1.01, 0.55, 0.6),
    "nst-brisk": VoiceVariant("nst", 1.06, 0.71, 0.84),
}


class SynthesisFailure(Exception):
    def __init__(self, message: str, status: int = HTTPStatus.BAD_REQUEST, code: str = "invalid_request"):
        super().__init__(message)
        self.status = int(status)
        self.code = code


@dataclass(frozen=True)
class SynthesisRequest:
    text: str
    voice: str
    speed: float


class Synthesizer(Protocol):
    @property
    def loaded_voices(self) -> list[str]: ...

    def synthesize(self, request: SynthesisRequest) -> bytes: ...


def sanitize_text(value: str, maximum: int) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    cleaned = "".join(
        character
        for character in normalized
        if character not in "\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069"
        and (character in "\n\t" or unicodedata.category(character) not in {"Cc", "Cf"})
    )
    return re.sub(r"\s+", " ", cleaned).strip()[:maximum]


def parse_synthesis_request(payload: Any) -> SynthesisRequest:
    if not isinstance(payload, dict):
        raise SynthesisFailure("Request body must be a JSON object.")
    unknown = set(payload) - ALLOWED_REQUEST_KEYS
    if unknown:
        raise SynthesisFailure("Request contains unsupported fields.", code="unsupported_fields")
    if payload.get("model") != MODEL_ID:
        raise SynthesisFailure("Unknown TTS model.", status=HTTPStatus.NOT_FOUND, code="model_not_found")
    if payload.get("response_format", "wav") != "wav":
        raise SynthesisFailure("Local Piper supports response_format=wav only.", code="unsupported_format")
    text_value = payload.get("input")
    if not isinstance(text_value, str):
        raise SynthesisFailure("input must be text.")
    text = sanitize_text(text_value, MAX_TEXT_CHARACTERS + 1)
    if not text:
        raise SynthesisFailure("input was empty.", code="empty_input")
    if len(text) > MAX_TEXT_CHARACTERS:
        raise SynthesisFailure("input exceeds the 600-character limit.", status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE, code="input_too_large")
    voice = payload.get("voice")
    if not isinstance(voice, str) or voice not in VOICE_VARIANTS:
        raise SynthesisFailure("Unknown or missing Piper voice.", code="voice_not_found")
    speed_value = payload.get("speed", 1)
    if isinstance(speed_value, bool) or not isinstance(speed_value, (int, float)):
        raise SynthesisFailure("speed must be a finite number.", code="invalid_speed")
    speed = float(speed_value)
    if speed != speed or speed in (float("inf"), float("-inf")) or not 0.5 <= speed <= 2:
        raise SynthesisFailure("speed must be between 0.5 and 2.", code="invalid_speed")
    instructions = payload.get("instructions")
    if instructions is not None:
        if not isinstance(instructions, str) or len(instructions) > MAX_INSTRUCTIONS_CHARACTERS:
            raise SynthesisFailure("instructions must be at most 400 characters.", code="invalid_instructions")
        # Piper has no instruction-following surface. Accepting but ignoring this
        # bounded field preserves OpenAI request compatibility without treating it
        # as executable input.
    return SynthesisRequest(text=text, voice=voice, speed=speed)


class PiperSynthesizer:
    def __init__(self, cache_dir: Path):
        try:
            from piper.config import SynthesisConfig
            from piper.voice import PiperVoice
        except ImportError as error:
            raise RuntimeError("piper-tts runtime is missing; run npm run setup:tts") from error

        self._SynthesisConfig = SynthesisConfig
        paths = {
            "lisa": (
                cache_dir / "voices" / "lisa" / "sv_SE-lisa-medium.onnx",
                cache_dir / "voices" / "lisa" / "sv_SE-lisa-medium.onnx.json",
            ),
            "nst": (
                cache_dir / "voices" / "nst" / "sv_SE-nst-medium.onnx",
                cache_dir / "voices" / "nst" / "sv_SE-nst-medium.onnx.json",
            ),
        }
        self._voices: dict[str, Any] = {}
        self._locks: dict[str, threading.Lock] = {}
        for voice_id, (model_path, config_path) in paths.items():
            if not model_path.is_file() or not config_path.is_file():
                raise RuntimeError(f"Piper voice {voice_id} is missing from {cache_dir}; run npm run setup:tts")
            self._voices[voice_id] = PiperVoice.load(str(model_path), config_path=str(config_path))
            self._locks[voice_id] = threading.Lock()

    @property
    def loaded_voices(self) -> list[str]:
        return sorted(VOICE_VARIANTS)

    def synthesize(self, request: SynthesisRequest) -> bytes:
        variant = VOICE_VARIANTS[request.voice]
        voice = self._voices[variant.base_voice]
        effective_rate = max(0.65, min(1.45, request.speed * variant.rate_multiplier))
        config = self._SynthesisConfig(
            length_scale=max(0.69, min(1.54, 1 / effective_rate)),
            noise_scale=variant.noise_scale,
            noise_w_scale=variant.noise_w,
        )
        audio = bytearray()
        sample_rate = sample_width = channels = None
        with self._locks[variant.base_voice]:
            for chunk in voice.synthesize(request.text, syn_config=config):
                sample_rate = chunk.sample_rate
                sample_width = chunk.sample_width
                channels = chunk.sample_channels
                audio.extend(chunk.audio_int16_bytes)
                if len(audio) + 128 > MAX_WAV_BYTES:
                    raise SynthesisFailure(
                        "Synthesized audio exceeded its safe size limit.",
                        status=HTTPStatus.BAD_GATEWAY,
                        code="audio_too_large",
                    )
        if not audio or not sample_rate or not sample_width or not channels:
            raise SynthesisFailure("Piper returned empty audio.", status=HTTPStatus.BAD_GATEWAY, code="empty_audio")
        output = io.BytesIO()
        with wave.open(output, "wb") as wav_file:
            wav_file.setnchannels(channels)
            wav_file.setsampwidth(sample_width)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(audio)
        body = output.getvalue()
        if len(body) > MAX_WAV_BYTES:
            raise SynthesisFailure("Synthesized WAV exceeded its safe size limit.", status=HTTPStatus.BAD_GATEWAY, code="audio_too_large")
        return body


class SlidingWindowLimiter:
    def __init__(self):
        self._events: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        cutoff = now - RATE_LIMIT_WINDOW_SECONDS
        with self._lock:
            current = [event for event in self._events.get(key, []) if event > cutoff]
            if len(current) >= RATE_LIMIT_REQUESTS:
                self._events[key] = current
                return False
            current.append(now)
            self._events[key] = current
            return True


class PiperHttpServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, address: tuple[str, int], synthesizer: Synthesizer, api_key: str):
        super().__init__(address, PiperRequestHandler)
        self.synthesizer = synthesizer
        self.api_key = api_key
        self.synthesis_slots = threading.BoundedSemaphore(2)
        self.rate_limiter = SlidingWindowLimiter()


class PiperRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ThirdPlacePiper/1"

    @property
    def piper_server(self) -> PiperHttpServer:
        return self.server  # type: ignore[return-value]

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(REQUEST_TIMEOUT_SECONDS)

    def log_message(self, format_string: str, *args: Any) -> None:
        # Never log request JSON or Authorization. The standard format only
        # contains client, method/path and response status.
        print(f"[tts] {self.client_address[0]} {format_string % args}")

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, error: SynthesisFailure) -> None:
        self.close_connection = True
        self._json(error.status, {"error": {"message": str(error), "type": "invalid_request_error", "code": error.code}})

    def _authorized(self) -> bool:
        expected = self.piper_server.api_key
        if not expected:
            return True
        supplied = self.headers.get("Authorization", "")
        prefix = "Bearer "
        return supplied.startswith(prefix) and hmac.compare_digest(supplied[len(prefix):], expected)

    def do_GET(self) -> None:
        if not self._authorized():
            self._error(SynthesisFailure("Unauthorized.", HTTPStatus.UNAUTHORIZED, "unauthorized"))
            return
        if self.path == "/health":
            self._json(HTTPStatus.OK, {
                "ok": True,
                "model": MODEL_ID,
                "voices": self.piper_server.synthesizer.loaded_voices,
            })
            return
        if self.path == "/v1/models":
            self._json(HTTPStatus.OK, {
                "object": "list",
                "data": [{"id": MODEL_ID, "object": "model", "owned_by": "local-piper"}],
            })
            return
        self._error(SynthesisFailure("Not found.", HTTPStatus.NOT_FOUND, "not_found"))

    def do_POST(self) -> None:
        if self.path != "/v1/audio/speech":
            self._error(SynthesisFailure("Not found.", HTTPStatus.NOT_FOUND, "not_found"))
            return
        if not self._authorized():
            self._error(SynthesisFailure("Unauthorized.", HTTPStatus.UNAUTHORIZED, "unauthorized"))
            return
        if not self.piper_server.rate_limiter.allow(self.client_address[0]):
            self._error(SynthesisFailure("TTS rate limit reached.", HTTPStatus.TOO_MANY_REQUESTS, "rate_limited"))
            return
        if self.headers.get("Transfer-Encoding"):
            self._error(SynthesisFailure("Chunked request bodies are not accepted.", HTTPStatus.LENGTH_REQUIRED, "content_length_required"))
            return
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self._error(SynthesisFailure("Content-Type must be application/json.", HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_content_type"))
            return
        try:
            content_length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            content_length = -1
        if content_length < 1:
            self._error(SynthesisFailure("A Content-Length is required.", HTTPStatus.LENGTH_REQUIRED, "content_length_required"))
            return
        if content_length > MAX_REQUEST_BYTES:
            self._error(SynthesisFailure("Request body is too large.", HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request_too_large"))
            return
        try:
            raw = self.rfile.read(content_length)
            if len(raw) != content_length:
                raise SynthesisFailure("Request body ended early.", code="incomplete_body")
            payload = json.loads(raw.decode("utf-8"))
            request = parse_synthesis_request(payload)
        except UnicodeDecodeError:
            self._error(SynthesisFailure("Request body must be UTF-8 JSON.", code="invalid_json"))
            return
        except json.JSONDecodeError:
            self._error(SynthesisFailure("Request body was invalid JSON.", code="invalid_json"))
            return
        except SynthesisFailure as error:
            self._error(error)
            return
        if not self.piper_server.synthesis_slots.acquire(blocking=False):
            self._error(SynthesisFailure("Local TTS is busy.", HTTPStatus.SERVICE_UNAVAILABLE, "tts_busy"))
            return
        try:
            body = self.piper_server.synthesizer.synthesize(request)
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)
        except SynthesisFailure as error:
            self._error(error)
        except Exception:
            self._error(SynthesisFailure("Local TTS synthesis failed.", HTTPStatus.INTERNAL_SERVER_ERROR, "synthesis_failed"))
        finally:
            self.piper_server.synthesis_slots.release()


def create_server(port: int, synthesizer: Synthesizer, api_key: str = "", *, host: str = LOOPBACK_HOST) -> PiperHttpServer:
    if host != LOOPBACK_HOST:
        raise ValueError("The Piper sidecar is loopback-only and must bind 127.0.0.1")
    return PiperHttpServer((LOOPBACK_HOST, port), synthesizer, api_key)


def main() -> None:
    parser = argparse.ArgumentParser(description="The Third Place local Piper TTS sidecar")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PIPER_TTS_PORT", "8179")))
    parser.add_argument("--cache-dir", default=os.environ.get("PIPER_TTS_CACHE_DIR", ".cache/piper-tts"))
    args = parser.parse_args()
    api_key = os.environ.get("PIPER_TTS_API_KEY", "").strip()
    if not 1 <= args.port <= 65535:
        raise SystemExit("PIPER_TTS_PORT must be between 1 and 65535")
    synthesizer = PiperSynthesizer(Path(args.cache_dir).resolve())
    server = create_server(args.port, synthesizer, api_key)
    stop = lambda *_: threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    print(f"[tts] Piper ready on http://{LOOPBACK_HOST}:{server.server_port}; model={MODEL_ID}; voices={len(synthesizer.loaded_voices)}")
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
