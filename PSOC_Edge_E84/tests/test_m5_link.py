import ctypes
import importlib.util
import json
import math
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


configure = module("configure_m5", ROOT / "configure_m5.py")
listener = module("m5_listener", ROOT / "tools/m5_listener.py")
TOKEN = "a" * 64
EVENT_ID = "0123456789abcdef" * 2


class ConfigurationTests(unittest.TestCase):
    def test_private_unicast_and_token(self):
        self.assertEqual(configure.configuration("192.168.1.50", 8768, TOKEN),
                         {"host": "192.168.1.50", "port": 8768, "token": TOKEN})

    def test_invalid_destinations(self):
        for host in ("example.com", "https://192.168.1.50", "8.8.8.8", "127.0.0.1",
                     "224.0.0.1", "255.255.255.255", "192.168.1.0", "192.168.1.255", "::1"):
            with self.subTest(host=host), self.assertRaises(ValueError):
                configure.configuration(host, 8768, TOKEN)

    def test_invalid_port_and_token(self):
        self.assertEqual(configure.configuration("192.168.1.50", 65534, TOKEN)["port"], 65534)
        for port in (0, 1023, 65535, 65536, True):
            with self.assertRaises(ValueError):
                configure.configuration("192.168.1.50", port, TOKEN)
        malicious = TOKEN + '\"}\\n'
        with self.assertRaises(ValueError) as error:
            configure.configuration("192.168.1.50", 8768, malicious)
        self.assertNotIn(malicious, str(error.exception))

    def test_private_file_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            configure.atomic_private_write(path, TOKEN)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(path.read_text(), TOKEN)


class ListenerTests(unittest.TestCase):
    def packet(self, **updates):
        event = dict(v=1, type="chime", event_id=EVENT_ID, score=.18, token=TOKEN)
        event.update(updates)
        return json.dumps(event).encode()

    def test_valid_event_does_not_expose_token(self):
        event = listener.parse_event(self.packet(), TOKEN)
        self.assertEqual(event["event_id"], EVENT_ID)
        self.assertNotIn("token", event)

    def test_invalid_or_unauthenticated_events(self):
        for update in (dict(token="b" * 64), dict(token="é" * 64), dict(event_id="../bad"),
                       dict(v=True), dict(type="servo"), dict(score=-2), dict(score=True),
                       dict(score=math.nan), dict(score=math.inf), dict(score=10 ** 350)):
            with self.subTest(update=update), self.assertRaises(ValueError):
                listener.parse_event(self.packet(**update), TOKEN)
        for packet in (b"not-json", b"x" * 513, b"[]"):
            with self.assertRaises(ValueError):
                listener.parse_event(packet, TOKEN)

    def test_deduplication_expiry_and_capacity(self):
        cache = listener.Deduplicator(capacity=2, ttl=10)
        self.assertTrue(cache.accept("a", 0))
        self.assertFalse(cache.accept("a", 1))
        self.assertTrue(cache.accept("b", 2))
        self.assertTrue(cache.accept("c", 3))
        self.assertNotIn("a", cache.seen)
        self.assertTrue(cache.accept("b", 12))


@unittest.skipUnless(shutil.which("cc"), "A host C compiler is needed for serializer tests")
class FirmwareSerializerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        shared = Path(cls.directory.name) / "m5_protocol.so"
        subprocess.run([shutil.which("cc"), "-shared", "-fPIC", "-std=c11", "-Wall", "-Wextra", "-Werror",
                        str(ROOT / "source/m5_protocol.c"), "-o", str(shared)], check=True, capture_output=True)
        cls.library = ctypes.CDLL(str(shared))
        cls.format = cls.library.m5_message_format
        cls.format.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_uint32),
                              ctypes.c_float, ctypes.c_char_p]
        cls.format.restype = ctypes.c_size_t

    def serialize(self, score=.18, capacity=256, token=TOKEN):
        output = ctypes.create_string_buffer(capacity)
        words = (ctypes.c_uint32 * 4)(0x01234567, 0x89abcdef, 0x01234567, 0x89abcdef)
        length = self.format(output, capacity, words, score, token.encode())
        return length, output.value

    def test_firmware_output_is_accepted_by_receiver(self):
        length, packet = self.serialize()
        self.assertEqual(length, len(packet))
        event = listener.parse_event(packet, TOKEN)
        self.assertEqual(event["event_id"], EVENT_ID)
        self.assertAlmostEqual(event["score"], .18)
        self.assertEqual(listener.parse_event(self.serialize(score=-1)[1], TOKEN)["score"], -1)

    def test_bad_score_bad_token_and_truncation_never_form_packet(self):
        for score in (math.nan, math.inf, -2):
            self.assertEqual(self.serialize(score=score)[0], 0)
        self.assertEqual(self.serialize(token='"' * 64)[0], 0)
        self.assertEqual(self.serialize(capacity=8), (0, b""))
