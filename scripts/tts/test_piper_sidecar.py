import io
import json
import threading
import unittest
import urllib.error
import urllib.request
import wave

from scripts.tts.piper_sidecar import (
    MODEL_ID,
    LOOPBACK_HOST,
    SynthesisRequest,
    VOICE_VARIANTS,
    create_server,
    parse_synthesis_request,
)


class FakeSynthesizer:
    loaded_voices = sorted(VOICE_VARIANTS)

    def __init__(self):
        self.requests = []

    def synthesize(self, request: SynthesisRequest) -> bytes:
        self.requests.append(request)
        output = io.BytesIO()
        with wave.open(output, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(22_050)
            wav_file.writeframes(b"\0\0" * 32)
        return output.getvalue()


class PiperSidecarTest(unittest.TestCase):
    def setUp(self):
        self.synthesizer = FakeSynthesizer()
        self.server = create_server(0, self.synthesizer, "test-secret-that-is-long-enough")
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, path, *, method="GET", payload=None, authorized=True):
        body = None if payload is None else json.dumps(payload).encode()
        headers = {}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if authorized:
            headers["Authorization"] = "Bearer test-secret-that-is-long-enough"
        return urllib.request.urlopen(urllib.request.Request(self.base + path, data=body, headers=headers, method=method), timeout=2)

    def test_health_models_and_authorization(self):
        with self.assertRaises(urllib.error.HTTPError) as unauthorized:
            self.request("/health", authorized=False)
        self.assertEqual(unauthorized.exception.code, 401)
        with self.request("/health") as response:
            health = json.load(response)
        self.assertTrue(health["ok"])
        self.assertIn("lisa-warm", health["voices"])
        with self.request("/v1/models") as response:
            models = json.load(response)
        self.assertEqual(models["data"][0]["id"], MODEL_ID)

    def test_openai_compatible_wav_request_is_strict_and_bounded(self):
        payload = {"model": MODEL_ID, "input": "  hej\u202e   världen  ", "voice": "lisa-warm", "response_format": "wav", "speed": 0.98}
        with self.request("/v1/audio/speech", method="POST", payload=payload) as response:
            body = response.read()
            self.assertEqual(response.headers["Content-Type"], "audio/wav")
            self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(body[:4], b"RIFF")
        self.assertEqual(self.synthesizer.requests, [SynthesisRequest("hej världen", "lisa-warm", 0.98)])

        with self.assertRaises(urllib.error.HTTPError) as invalid:
            self.request("/v1/audio/speech", method="POST", payload={**payload, "response_format": "mp3"})
        self.assertEqual(invalid.exception.code, 400)
        with self.assertRaises(urllib.error.HTTPError) as smuggled:
            self.request("/v1/audio/speech", method="POST", payload={**payload, "extra": True})
        self.assertEqual(smuggled.exception.code, 400)
        with self.assertRaises(urllib.error.HTTPError) as oversized:
            self.request("/v1/audio/speech", method="POST", payload={**payload, "input": "x" * 601})
        self.assertEqual(oversized.exception.code, 413)

    def test_voice_aliases_and_loopback_policy_are_explicit(self):
        self.assertEqual(LOOPBACK_HOST, "127.0.0.1")
        with self.assertRaises(ValueError):
            create_server(0, self.synthesizer, host="0.0.0.0")
        for voice in VOICE_VARIANTS:
            parsed = parse_synthesis_request({"model": MODEL_ID, "input": "hej", "voice": voice, "response_format": "wav"})
            self.assertEqual(parsed.voice, voice)


if __name__ == "__main__":
    unittest.main()
