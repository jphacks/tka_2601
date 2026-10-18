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
spec = importlib.util.spec_from_file_location("configure_wifi", ROOT / "configure_wifi.py")
wifi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wifi)


class WiFiConfigurationTests(unittest.TestCase):
    def test_profile_and_utf8_credentials_reach_firmware(self):
        # Compile the actual settings code with a generated private header in
        # isolation, never reading or modifying the user's wifi_config.h.
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            for name in ("wifi_settings.c", "wifi_settings.h", "wifi_config.example.h"):
                shutil.copyfile(ROOT / "source" / name, temp / name)
            (temp / "cy_wcm.h").write_text('''#pragma once
#define CY_WCM_MAX_SSID_LEN 32
#define CY_WCM_MAX_PASSPHRASE_LEN 63
typedef enum { CY_WCM_SECURITY_UNKNOWN = 7, CY_WCM_SECURITY_WPA2_AES_PSK = 19 } cy_wcm_security_t;
''')
            ssid = 'のぞみのiPhone'
            password = 'test-"pass\\123'
            for hotspot, legacy in ((False, False), (True, False), (False, True)):
                with self.subTest(hotspot=hotspot, legacy=legacy):
                    header = wifi.configuration(ssid, password, hotspot)
                    if legacy:
                        header = '\n'.join(line for line in header.splitlines()
                                           if 'WIFI_HOTSPOT_COMPATIBILITY' not in line)
                    (temp / "wifi_config.h").write_text(header)
                    (temp / "check.c").write_text(f'''#include "wifi_settings.h"
#include <assert.h>
#include <string.h>
int main(void) {{
    assert(strcmp(wifi_ssid, {wifi.c_literal(ssid)}) == 0);
    assert(strcmp(wifi_password, {wifi.c_literal(password)}) == 0);
    assert(wifi_hotspot_compatibility == {int(hotspot)});
    assert(wifi_security == {'CY_WCM_SECURITY_WPA2_AES_PSK' if hotspot else 'CY_WCM_SECURITY_UNKNOWN'});
}}
''')
                    binary = temp / "check"
                    subprocess.run(['clang', '-std=c11', '-Wall', '-Wextra', '-Werror',
                                    '-I', str(temp), str(temp / 'wifi_settings.c'),
                                    str(temp / 'check.c'), '-o', str(binary)], check=True)
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
            (temp / 'source').mkdir()
            target = temp / 'source/wifi_config.h'
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
