import contextlib
import importlib.util
import io
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("configure_api", Path(__file__).parents[1] / "configure_api.py")
configure_api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(configure_api)


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
        self.project = self.root / "PSOC_Edge_E84"
        (self.project / "source").mkdir(parents=True)
        self.other_directory = self.root / "other-directory"
        self.other_directory.mkdir()
        self.target = self.project / "source" / "api_config.h"
        self.target.write_text("existing-config")
        self.wrapper = self.project / "source" / "api_settings.h"
        shutil.copyfile(Path(__file__).parents[1] / "source" / "api_settings.h", self.wrapper)
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

    def test_missing_project_env_does_not_fall_back_to_parent(self):
        with self.cli() as (output, errors), self.assertRaises(SystemExit) as error:
            configure_api.main()
        self.assertEqual(error.exception.code, 2)
        self.assertEqual(self.target.read_text(), "existing-config")
        self.assertNotIn(self.parent_key, output.getvalue() + errors.getvalue())

    def test_explicit_env_still_overrides_project_default(self):
        self.write_env(self.project / ".env", "local.example.com", self.key)
        with self.cli("--env", str(self.root / ".env")) as (output, errors):
            configure_api.main()
        self.assertEqual(self.target.read_text(), configure_api.configuration({
            "DOOR_UI_HOSTNAME": "parent.example.com", "DOOR_API_KEY": self.parent_key,
        }))
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o600)
        self.assertNotIn(self.parent_key, output.getvalue() + errors.getvalue())

    def test_invalid_env_preserves_previous_configuration_without_disclosing_key(self):
        wrapper_mtime = self.wrapper.stat().st_mtime_ns
        for host, key in (("local.example.com", "invalid-test-token"),
                          ("https://local.example.com", self.key)):
            with self.subTest(host=host):
                self.write_env(self.project / ".env", host, key)
                with self.cli() as (output, errors), self.assertRaises(SystemExit) as error:
                    configure_api.main()
                self.assertEqual(error.exception.code, 2)
                self.assertEqual(self.target.read_text(), "existing-config")
                self.assertEqual(self.wrapper.stat().st_mtime_ns, wrapper_mtime)
                self.assertNotIn(key, output.getvalue() + errors.getvalue())

    @unittest.skipUnless(shutil.which("clang") and shutil.which("make"), "clang and make are required")
    def test_first_configuration_rebuilds_an_existing_unconfigured_binary(self):
        self.target.unlink()
        wrapper_content = self.wrapper.read_bytes()
        probe = self.project / "probe.c"
        probe.write_text('#include "api_settings.h"\n#include <stdio.h>\n'
                         'int main(void) { puts(DOOR_API_HOST); puts(DOOR_API_KEY); return 0; }\n')
        (self.project / "Makefile").write_text(
            "probe: probe.c\n"
            "\t$(CC) -std=c11 -MMD -MP -MF probe.d -MT probe -Isource probe.c -o probe\n"
            "-include probe.d\n")
        # Distinct timestamps make this reliable on make versions with coarse
        # timestamp comparisons. The generated header is initially absent.
        old = time.time() - 10
        for path in (probe, self.wrapper):
            os.utime(path, (old, old))

        def build_and_read():
            subprocess.run(["make", "--no-print-directory", "CC=clang", "probe"],
                           cwd=self.project, check=True, capture_output=True, text=True)
            return subprocess.check_output([str(self.project / "probe")], text=True).splitlines()

        self.assertEqual(build_and_read()[1], "")
        dependencies = self.project / "probe.d"
        self.assertIn("api_settings.h", dependencies.read_text())
        self.assertNotIn("api_config.h", dependencies.read_text())
        built = time.time() - 2
        os.utime(self.project / "probe", (built, built))

        self.write_env(self.project / ".env", "configured.example.com", self.key)
        with self.cli():
            configure_api.main()
        self.assertEqual(build_and_read(), ["configured.example.com", self.key])
        self.assertIn("api_config.h", dependencies.read_text())
        self.assertEqual(self.wrapper.read_bytes(), wrapper_content)

        # Subsequent edits must continue to update the same incremental build.
        old = time.time() - 10
        for path in (self.target, self.wrapper):
            os.utime(path, (old, old))
        built = time.time() - 2
        os.utime(self.project / "probe", (built, built))
        next_key = "replacement-test-token-" * 3
        self.write_env(self.project / ".env", "updated.example.com", next_key)
        with self.cli():
            configure_api.main()
        self.assertEqual(build_and_read(), ["updated.example.com", next_key])
        self.assertEqual(self.wrapper.read_bytes(), wrapper_content)
