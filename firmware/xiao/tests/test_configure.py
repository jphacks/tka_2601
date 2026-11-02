import contextlib
import importlib.util
import io
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


wifi = load("configure_wifi")
configure_api = load("configure_api")
upload = load("configure_upload")
HAS_DOTENV = importlib.util.find_spec("dotenv") is not None


class WiFiConfigurationTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("clang++"), "clang++ is required")
    def test_profile_and_utf8_credentials_reach_firmware(self):
        # Compile the generated private header in isolation, never reading or
        # modifying the user's wifi_config.h. The firmware consumes it as C++.
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            ssid = 'のぞみのiPhone'
            password = 'test-"pass\\123'
            for hotspot in (False, True):
                with self.subTest(hotspot=hotspot):
                    (temp / "wifi_config.h").write_text(wifi.configuration(ssid, password, hotspot))
                    (temp / "check.cpp").write_text(f'''#include "wifi_config.h"
#include <cassert>
#include <cstring>
static_assert(sizeof(WIFI_SSID) <= 33, "SSID exceeds 32 bytes");
static_assert(sizeof(WIFI_PASSWORD) <= 64, "Wi-Fi password exceeds 63 bytes");
int main() {{
    assert(std::strcmp(WIFI_SSID, "{ssid}") == 0);
    assert(std::strcmp(WIFI_PASSWORD, "test-\\"pass\\\\123") == 0);
    assert(WIFI_HOTSPOT_COMPATIBILITY == {int(hotspot)});
}}
''')
                    binary = temp / "check"
                    subprocess.run(['clang++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
                                    '-I', str(temp), str(temp / 'check.cpp'), '-o', str(binary)], check=True)
                    subprocess.run([str(binary)], check=True)

    def test_invalid_credentials_rejected_without_echoing_them(self):
        for ssid, password in (('', 'abcdefgh'), ('あ' * 11, 'abcdefgh'),
                               ('phone\0hidden', 'abcdefgh'), ('phone', 'short'),
                               ('phone', 'abc\nsecret'), ('phone', 'a' * 64)):
            with self.subTest(ssid_length=len(ssid), password_length=len(password)):
                with self.assertRaises(ValueError) as error:
                    wifi.configuration(ssid, password, True)
                self.assertNotIn(password, str(error.exception))

    def test_cli_keeps_private_permissions_and_preserves_file_on_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            target = temp / 'wifi_config.h'
            target.write_text('existing-config')
            arguments = ['configure_wifi.py', '--hotspot']
            with patch.object(wifi, '__file__', str(temp / 'configure_wifi.py')), \
                 patch('sys.argv', arguments), patch('builtins.input', return_value='phone'), \
                 patch.object(wifi.getpass, 'getpass', side_effect=['testpass123', 'mismatch']), \
                 contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit):
                wifi.main()
            self.assertEqual(target.read_text(), 'existing-config')
            output = io.StringIO()
            with patch.object(wifi, '__file__', str(temp / 'configure_wifi.py')), \
                 patch('sys.argv', arguments), patch('builtins.input', return_value='phone'), \
                 patch.object(wifi.getpass, 'getpass', return_value='testpass123'), \
                 contextlib.redirect_stdout(output):
                wifi.main()
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            self.assertIn('#define WIFI_HOTSPOT_COMPATIBILITY 1', target.read_text())
            self.assertNotIn('testpass123', output.getvalue())
            self.assertIn('bash run.sh upload <port>', output.getvalue())


class ApiConfigurationTests(unittest.TestCase):
    def test_missing_key_rejected(self):
        with self.assertRaises(ValueError):
            configure_api.configuration({})

    def test_header_injection_rejected_without_disclosing_key(self):
        key = "private-test-token" * 3 + "\r\nX-Injected: yes"
        with self.assertRaises(ValueError) as error:
            configure_api.configuration({"DOOR_API_KEY": key})
        self.assertNotIn(key, str(error.exception))

    def test_scheme_port_and_path_rejected(self):
        for host in ("https://example.com", "example.com:443", "example.com/path", "example.com\r\nX: y"):
            with self.subTest(host=host), self.assertRaises(ValueError):
                configure_api.configuration({"DOOR_API_KEY": "a" * 64, "DOOR_UI_HOSTNAME": host})

    def test_only_client_settings_are_emitted(self):
        text = configure_api.configuration({
            "DOOR_API_KEY": "a" * 64,
            "DOOR_UI_HOSTNAME": "door-ui.shionkk.f5.si",
            "LIVEKIT_API_SECRET": "unrelated-server-secret",
        })
        self.assertIn("#define DOOR_API_KEY ", text)
        self.assertIn("#define DOOR_API_HOST ", text)
        self.assertNotIn("LIVEKIT", text)
        self.assertNotIn("unrelated-server-secret", text)

    def test_relay_configuration_and_safe_c_literals(self):
        text = configure_api.configuration({
            "DOOR_API_KEY": "a" * 64, "DOOR_RELAY_MODE": "away",
            "DOOR_DEVICE_KEY": 'sample-device-"\\',
        })
        self.assertIn("#define DOOR_RELAY_MODE ", text)
        self.assertIn("#define DOOR_DEVICE_KEY ", text)
        self.assertIn(r"\042\134", text)
        self.assertNotIn('sample-device-', text)

    def test_invalid_device_keys_and_modes_are_not_disclosed(self):
        for key in ("has space", "newline\nsecret", "日本語", "a" * 513):
            with self.subTest(key_length=len(key)), self.assertRaises(ValueError) as error:
                configure_api.configuration({"DOOR_API_KEY": "a" * 64, "DOOR_DEVICE_KEY": key})
            self.assertNotIn(key, str(error.exception))
        with self.assertRaises(ValueError):
            configure_api.configuration({"DOOR_API_KEY": "a" * 64, "DOOR_RELAY_MODE": "custom"})


class ApiConfigurationCliTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.project = self.root / "xiao"
        self.project.mkdir()
        self.other_directory = self.root / "other-directory"
        self.other_directory.mkdir()
        self.target = self.project / "api_config.h"
        self.target.write_text("existing-config")
        self.key = "local-test-token-" * 3
        self.parent_key = "parent-test-token-" * 3
        self.write_env(self.root / ".env", "parent.example.com", self.parent_key)

    @staticmethod
    def write_env(path, host, key):
        path.write_text(f"DOOR_UI_HOSTNAME={host}\nDOOR_API_KEY={key}\n")

    @contextlib.contextmanager
    def cli(self, *arguments):
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(configure_api, "__file__", str(self.project / "configure_api.py")), \
             patch("sys.argv", ["configure_api.py", *arguments]), \
             contextlib.chdir(self.other_directory), \
             contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            yield output, errors

    @unittest.skipUnless(HAS_DOTENV, "python-dotenv is required")
    def test_default_reads_project_env_independent_of_working_directory(self):
        self.write_env(self.project / ".env", "local.example.com", self.key)
        self.write_env(self.other_directory / ".env", "cwd.example.com", "cwd-test-token-" * 3)
        with self.cli() as (output, errors):
            configure_api.main()
        self.assertEqual(self.target.read_text(), configure_api.configuration({
            "DOOR_UI_HOSTNAME": "local.example.com", "DOOR_API_KEY": self.key,
        }))
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o600)
        self.assertNotIn(self.key, output.getvalue() + errors.getvalue())
        self.assertNotIn(self.parent_key, output.getvalue() + errors.getvalue())
        self.assertIn("bash run.sh upload <port>", output.getvalue())

    def test_missing_project_env_does_not_fall_back_to_parent(self):
        with self.cli() as (output, errors), self.assertRaises(SystemExit) as error:
            configure_api.main()
        self.assertEqual(error.exception.code, 2)
        self.assertEqual(self.target.read_text(), "existing-config")
        self.assertNotIn(self.parent_key, output.getvalue() + errors.getvalue())

    @unittest.skipUnless(HAS_DOTENV, "python-dotenv is required")
    def test_explicit_env_still_overrides_project_default(self):
        self.write_env(self.project / ".env", "local.example.com", self.key)
        with self.cli("--env", str(self.root / ".env")) as (output, errors):
            configure_api.main()
        self.assertEqual(self.target.read_text(), configure_api.configuration({
            "DOOR_UI_HOSTNAME": "parent.example.com", "DOOR_API_KEY": self.parent_key,
        }))
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o600)
        self.assertNotIn(self.parent_key, output.getvalue() + errors.getvalue())

    @unittest.skipUnless(HAS_DOTENV, "python-dotenv is required")
    def test_invalid_env_preserves_previous_configuration_without_disclosing_key(self):
        for host, key in (("local.example.com", "invalid-test-token"),
                          ("https://local.example.com", self.key)):
            with self.subTest(host=host):
                self.write_env(self.project / ".env", host, key)
                with self.cli() as (output, errors), self.assertRaises(SystemExit) as error:
                    configure_api.main()
                self.assertEqual(error.exception.code, 2)
                self.assertEqual(self.target.read_text(), "existing-config")
                self.assertNotIn(key, output.getvalue() + errors.getvalue())


class UploadConfigurationTests(unittest.TestCase):
    ca = "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n"

    def test_configuration_generates_escaped_c_strings(self):
        result = upload.configuration("receiver.example.com", "a" * 64, self.ca)
        self.assertIn("#define AUDIO_UPLOAD_HOST", result)
        self.assertIn("#define AUDIO_UPLOAD_TOKEN", result)
        self.assertIn("#define AUDIO_UPLOAD_CA_PEM", result)
        self.assertNotIn("receiver.example.com", result)

    def test_rejects_header_injection_urls_and_private_keys(self):
        for host in ("https://receiver.example.com", "x\r\nHost: evil", "-bad.example", "x:443", ""):
            with self.subTest(host=host), self.assertRaises(ValueError):
                upload.configuration(host, "a" * 64, self.ca)
        for token in ("", "short", "a" * 32 + "\nInjected: value"):
            with self.subTest(token_length=len(token)), self.assertRaises(ValueError):
                upload.configuration("receiver.example.com", token, self.ca)
        with self.assertRaises(ValueError):
            upload.configuration("receiver.example.com", "a" * 64, self.ca + "PRIVATE KEY")

    def test_cli_writes_private_header_next_to_script(self):
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            ca = temp / "root.pem"
            ca.write_text(self.ca)
            output = io.StringIO()
            with patch.object(upload, "__file__", str(temp / "configure_upload.py")), \
                 patch("sys.argv", ["configure_upload.py", "--ca", str(ca)]), \
                 patch.dict("os.environ", {"AUDIO_UPLOAD_HOST": "receiver.example.com",
                                           "AUDIO_RECEIVER_TOKEN": "a" * 64}), \
                 contextlib.redirect_stdout(output):
                upload.main()
            target = temp / "upload_config.h"
            self.assertEqual(target.read_text(), upload.configuration("receiver.example.com", "a" * 64, self.ca))
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            self.assertNotIn("a" * 64, output.getvalue())
            self.assertIn("bash run.sh upload <port>", output.getvalue())


if __name__ == "__main__":
    unittest.main()
