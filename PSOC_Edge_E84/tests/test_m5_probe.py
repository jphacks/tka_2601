"""Exercise the E84-to-M5 diagnostic handshake without radio hardware."""
import ctypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "0123456789abcdef" * 4
EVENT_ID = "0123456789abcdef00000000ffffffff"
WORDS = (ctypes.c_uint32 * 4)(0x01234567, 0x89ABCDEF, 0, 0xFFFFFFFF)


@unittest.skipUnless(shutil.which("cc"), "A host C compiler is needed for protocol tests")
class ProbeProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        library = Path(cls.directory.name) / "m5_protocol.so"
        subprocess.run([
            shutil.which("cc"), "-shared", "-fPIC", "-std=c11", "-Wall", "-Wextra", "-Werror",
            str(ROOT / "source/m5_protocol.c"), "-o", str(library),
        ], check=True, capture_output=True)
        cls.library = ctypes.CDLL(str(library))
        cls.format = cls.library.m5_probe_format
        cls.format.argtypes = [ctypes.c_void_p, ctypes.c_size_t,
                               ctypes.POINTER(ctypes.c_uint32), ctypes.c_char_p, ctypes.c_bool]
        cls.format.restype = ctypes.c_size_t
        cls.matches = cls.library.m5_probe_reply_matches
        cls.matches.argtypes = [ctypes.c_void_p, ctypes.c_size_t,
                                ctypes.POINTER(ctypes.c_uint32), ctypes.c_char_p]
        cls.matches.restype = ctypes.c_bool

    def serialize(self, reply=False, token=TOKEN, capacity=256):
        output = ctypes.create_string_buffer(capacity)
        length = self.format(output, capacity, WORDS, token.encode(), reply)
        return length, output.value

    def packet(self, **updates):
        value = dict(v=1, type="pong", event_id=EVENT_ID, token=TOKEN)
        value.update(updates)
        return json.dumps(value, separators=(",", ":")).encode()

    def match(self, packet):
        # Allocate exactly the datagram length: a reply is not a C string.
        raw = (ctypes.c_char * len(packet)).from_buffer_copy(packet)
        return self.matches(raw, len(packet), WORDS, TOKEN.encode())

    def test_wire_format_and_id_word_order(self):
        for reply, kind in ((False, "ping"), (True, "pong")):
            with self.subTest(reply=reply):
                length, packet = self.serialize(reply=reply)
                self.assertEqual(packet, self.packet(type=kind))
                self.assertEqual(length, len(packet))
                self.assertEqual(self.match(packet), reply)

    def test_exact_capacity_needs_room_for_terminator(self):
        length, packet = self.serialize(reply=True)
        self.assertEqual(self.serialize(reply=True, capacity=length + 1), (length, packet))
        for capacity in (1, 8, length):
            with self.subTest(capacity=capacity):
                self.assertEqual(self.serialize(reply=True, capacity=capacity), (0, b""))

    def test_invalid_token_is_not_serialized(self):
        for token in ("", TOKEN[:-1], TOKEN + "0", "A" * 64, "g" * 64,
                      "é" * 64, '"' * 64, TOKEN[:-1] + "\n"):
            with self.subTest(token=token):
                self.assertEqual(self.serialize(token=token)[0], 0)

    def test_null_arguments_are_rejected(self):
        output = ctypes.create_string_buffer(256)
        self.assertEqual(self.format(None, 256, WORDS, TOKEN.encode(), False), 0)
        self.assertEqual(self.format(output, 0, WORDS, TOKEN.encode(), False), 0)
        self.assertEqual(self.format(output, 256, None, TOKEN.encode(), False), 0)
        self.assertEqual(self.format(output, 256, WORDS, None, False), 0)
        packet = self.packet()
        self.assertFalse(self.matches(None, len(packet), WORDS, TOKEN.encode()))
        self.assertFalse(self.matches(packet, len(packet), None, TOKEN.encode()))
        self.assertFalse(self.matches(packet, len(packet), WORDS, None))

    def test_reply_must_have_current_id_token_and_pong_type(self):
        self.assertTrue(self.match(self.packet()))
        for updates in (dict(type="ping"), dict(type="chime"), dict(v=2),
                        dict(event_id="0" * 32), dict(event_id=EVENT_ID.upper()),
                        dict(token="f" * 64), dict(token=TOKEN.upper())):
            with self.subTest(updates=updates):
                self.assertFalse(self.match(self.packet(**updates)))

    def test_only_exact_canonical_datagram_is_accepted(self):
        packet = self.packet()
        for invalid in (b"", packet[:-1], packet + b"\n", packet + b"\0", packet + packet,
                        b" " + packet, packet.replace(b',"token"', b', "token"'),
                        packet[:20] + b"\0" + packet[21:]):
            with self.subTest(packet=invalid):
                self.assertFalse(self.match(invalid))


@unittest.skipUnless(shutil.which("clang"), "Clang is needed for sanitized transport tests")
class ProbeTransportTests(unittest.TestCase):
    def test_peer_authentication_time_bound_and_cleanup(self):
        scenarios = (
            "success", "timeout", "wrong peer", "wrong port", "wrong token", "wrong ID",
            "ping reply", "trailing data", "truncated packet", "partial copy",
            "invalid replies then valid", "continuous packet flood", "send failure",
            "socket allocation failure", "buffer allocation failure", "buffer reference failure",
            "bind failure", "receive failure", "receive failure with allocated buffer",
            "null receive buffer", "missing interface", "interface down", "link down",
            "no DHCP address", "off subnet", "self address", "directed broadcast", "tick wrap",
        )
        with tempfile.TemporaryDirectory() as directory:
            staged = Path(directory)
            # Keep production sources together but never copy real private configuration.
            for name in ("m5_link.c", "m5_link.h", "m5_protocol.c", "m5_protocol.h", "m5_settings.h"):
                shutil.copyfile(ROOT / "source" / name, staged / name)
            (staged / "m5_config.h").write_text(
                '#pragma once\n#define M5_IPV4 "192.168.1.63"\n#define M5_PORT 8768u\n'
                f'#define M5_TOKEN "{TOKEN}"\n', encoding="ascii",
            )
            binary = staged / "probe"
            subprocess.run([
                shutil.which("clang"), "-std=c11", "-Wall", "-Wextra", "-Werror",
                "-fsanitize=address,undefined", "-I", str(ROOT / "tests/m5_probe_stubs"),
                "-I", str(staged), str(ROOT / "tests/m5_probe_harness.c"),
                str(staged / "m5_link.c"), str(staged / "m5_protocol.c"), "-o", str(binary),
            ], check=True, capture_output=True, text=True)
            for number, scenario in enumerate(scenarios):
                with self.subTest(scenario=scenario):
                    completed = subprocess.run(
                        [str(binary), str(number)], timeout=5, capture_output=True, text=True,
                        env={**os.environ, "ASAN_OPTIONS": "detect_stack_use_after_return=1"},
                    )
                    self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)


if __name__ == "__main__":
    unittest.main()
