import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
AVAILABLE = all(importlib.util.find_spec(name) for name in ("fastapi", "httpx"))
if AVAILABLE:
    from fastapi.testclient import TestClient
    from tools.fastapi_receiver import create_app


@unittest.skipUnless(AVAILABLE, "Install tools/requirements-receiver.txt for FastAPI tests")
class FastApiReceiverTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.token = "test-device-token-" + "a" * 32
        self.app = create_app(self.directory.name, self.token)
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)
        self.event_id = "0123456789abcdef" * 2
        self.path = "/v1/doorbell/recordings/" + self.event_id
        data = io.BytesIO()
        with wave.open(data, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(b"\x00\x01" * 1600)
        self.wav = data.getvalue()
        self.headers = {"Authorization": "Bearer " + self.token, "Content-Type": "audio/wav",
                        "X-Audio-Match-Score": "0.18", "X-Audio-Model-Version": "1"}

    def test_save_retry_and_conflict(self):
        created = self.client.put(self.path, content=self.wav, headers=self.headers)
        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.content, (self.event_id + "\n").encode())
        self.assertEqual(self.client.put(self.path, content=self.wav, headers=self.headers).status_code, 200)
        changed = self.wav[:-1] + b"\x03"
        self.assertEqual(self.client.put(self.path, content=changed, headers=self.headers).status_code, 409)
        self.assertEqual((Path(self.directory.name) / (self.event_id + ".wav")).read_bytes(), self.wav)

    def test_authentication_before_save(self):
        self.assertEqual(self.client.put(self.path, content=self.wav).status_code, 401)
        self.assertEqual(list(Path(self.directory.name).glob("*.wav")), [])
        self.assertEqual(self.client.get("/api/status").status_code, 401)
        self.assertTrue(self.client.get("/api/status", headers=self.headers).json()["ready"])

    def test_bad_framing_wav_and_metadata(self):
        for headers, body, expected in (
            ({**self.headers, "Content-Length": "999999"}, self.wav, 413),
            ({**self.headers, "Content-Length": str(len(self.wav) + 1)}, self.wav, 400),
            ({**self.headers, "Content-Length": str(len(self.wav) - 1)}, self.wav, 400),
            ({**self.headers, "Transfer-Encoding": "chunked"}, self.wav, 400),
            ({**self.headers, "Content-Type": "audio/mpeg"}, self.wav, 415),
            ({**self.headers, "X-Audio-Match-Score": "nan"}, self.wav, 400),
            ({**self.headers, "X-Audio-Model-Version": "2"}, self.wav, 400),
            (self.headers, b"x" * len(self.wav), 400),
        ):
            with self.subTest(expected=expected, headers=headers):
                self.assertEqual(self.client.put(self.path, content=body, headers=headers).status_code, expected)
        self.assertEqual(list(Path(self.directory.name).glob("*.wav")), [])

    def test_storage_failure_does_not_ack(self):
        with patch.object(self.app.state.store, "save", side_effect=OSError("disk failure")):
            response = self.client.put(self.path, content=self.wav, headers=self.headers)
        self.assertEqual(response.status_code, 503)
        self.assertNotEqual(response.content, (self.event_id + "\n").encode())

    def test_missing_token_fails_closed(self):
        with self.assertRaises(ValueError):
            create_app(self.directory.name, "")
