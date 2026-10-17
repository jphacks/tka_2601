import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("configure_upload", ROOT / "configure_upload.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class UploadConfigurationTests(unittest.TestCase):
    ca = "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n"

    def test_configuration_generates_escaped_c_strings(self):
        result = module.configuration("receiver.example.com", "a" * 64, self.ca)
        self.assertIn("#define AUDIO_UPLOAD_HOST", result)
        self.assertIn("#define AUDIO_UPLOAD_CA_PEM", result)
        self.assertNotIn("receiver.example.com", result)

    def test_rejects_header_injection_urls_and_private_keys(self):
        for host in ("https://receiver.example.com", "x\r\nHost: evil", "-bad.example", "x:443", ""):
            with self.subTest(host=host), self.assertRaises(ValueError):
                module.configuration(host, "a" * 64, self.ca)
        for token in ("", "short", "a" * 32 + "\nInjected: value"):
            with self.subTest(token_length=len(token)), self.assertRaises(ValueError):
                module.configuration("receiver.example.com", token, self.ca)
        with self.assertRaises(ValueError):
            module.configuration("receiver.example.com", "a" * 64, self.ca + "PRIVATE KEY")
