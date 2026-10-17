import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import wave

spec = importlib.util.spec_from_file_location("receiver", Path(__file__).parents[1] / "tools/receiver.py")
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)


def wav_bytes():
    output = io.BytesIO()
    with wave.open(output, "wb") as stream:
        stream.setnchannels(1); stream.setsampwidth(2); stream.setframerate(16000)
        stream.writeframes(b"\x00\x01" * 1600)
    return output.getvalue()


class RecordingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = receiver.RecordingStore(self.temp.name)
        self.event_id = "0123456789abcdef" * 2
        self.wav = wav_bytes()

    def test_durable_save_and_idempotent_retry(self):
        self.assertTrue(self.store.save(self.event_id, self.wav, .05))
        self.assertFalse(self.store.save(self.event_id, self.wav, .05))
        self.assertEqual((Path(self.temp.name) / f"{self.event_id}.wav").read_bytes(), self.wav)
        self.assertEqual(len(list(Path(self.temp.name).glob("*.wav"))), 1)

    def test_conflicting_retry_does_not_overwrite(self):
        self.store.save(self.event_id, self.wav)
        with self.assertRaises(FileExistsError):
            self.store.save(self.event_id, self.wav[:-1] + b"\x03")
        self.assertEqual((Path(self.temp.name) / f"{self.event_id}.wav").read_bytes(), self.wav)

    def test_partial_and_wrong_format_rejected(self):
        for data in (self.wav[:40], self.wav[:-1], self.wav + b"x", b"x" * len(self.wav)):
            with self.assertRaises(ValueError):
                self.store.save(self.event_id, data)
        self.assertEqual(list(Path(self.temp.name).glob("*.wav")), [])

    def test_id_validation(self):
        with self.assertRaises(ValueError):
            self.store.save("../bad", self.wav)

    def test_storage_failure_is_not_acknowledged(self):
        with patch.object(receiver.os, "fsync", side_effect=OSError("disk failure")):
            with self.assertRaises(OSError):
                self.store.save(self.event_id, self.wav)

    def test_recovery_after_wav_written_before_metadata(self):
        (Path(self.temp.name) / f"{self.event_id}.wav").write_bytes(self.wav)
        self.assertFalse(self.store.save(self.event_id, self.wav))
        self.assertTrue((Path(self.temp.name) / f"{self.event_id}.json").exists())

    def test_token_required(self):
        with self.assertRaises(ValueError):
            receiver.make_handler(self.store, "")

    def request(self, data, token="test-token", extra_headers=""):
        class FakeConnection:
            def __init__(self, request):
                self.input = io.BytesIO(request)
                self.output = io.BytesIO()
            def makefile(self, *_): return self.input
            def sendall(self, data): self.output.write(data)
            def settimeout(self, _): pass
        request = (f"PUT /v1/doorbell/recordings/{self.event_id} HTTP/1.1\r\n"
                   f"Host: localhost\r\nAuthorization: Bearer {token}\r\n"
                   f"Content-Type: audio/wav\r\nContent-Length: {len(data)}\r\n"
                   f"{extra_headers}\r\n").encode() + data
        connection = FakeConnection(request)
        receiver.make_handler(self.store, "test-token")(connection, ("127.0.0.1", 12345), None)
        return connection.output.getvalue()

    def test_http_ack_has_exact_persisted_id(self):
        response = self.request(self.wav)
        self.assertIn(b" 201 ", response.split(b"\r\n")[0])
        self.assertEqual(response.split(b"\r\n\r\n", 1)[1], (self.event_id + "\n").encode())
        retry = self.request(self.wav)
        self.assertIn(b" 200 ", retry.split(b"\r\n")[0])

    def test_http_unauthorized_does_not_store(self):
        self.assertIn(b" 401 ", self.request(self.wav, "wrong").split(b"\r\n")[0])
        self.assertEqual(list(Path(self.temp.name).glob("*.wav")), [])

    def test_http_storage_failure_never_returns_success(self):
        with patch.object(self.store, "save", side_effect=OSError("disk full")):
            response = self.request(self.wav)
        self.assertIn(b" 503 ", response.split(b"\r\n")[0])

    def test_http_ambiguous_framing_rejected(self):
        response = self.request(self.wav, extra_headers="Content-Length: 44\r\n")
        self.assertIn(b" 400 ", response.split(b"\r\n")[0])


if __name__ == "__main__":
    unittest.main()
