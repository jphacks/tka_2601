#!/usr/bin/env python3
"""Generate XIAO's authenticated Supabase settings connection without printing keys."""
import argparse
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import urlsplit


def configuration(values, ca):
    url = urlsplit((values.get("SUPABASE_URL") or "").strip())
    if (url.scheme != "https" or not url.hostname or url.port not in (None, 443)
            or url.username or url.password or url.query or url.fragment or url.path not in ("", "/")
            or len(url.hostname) > 127
            or not all(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
                       for label in url.hostname.split("."))):
        raise ValueError("SUPABASE_URL must be an HTTPS origin without a path or credentials.")
    key = values.get("SUPABASE_PUBLISHABLE_KEY") or ""
    device = values.get("DOOR_DEVICE_KEY") or ""
    for name, value in (("SUPABASE_PUBLISHABLE_KEY", key), ("DOOR_DEVICE_KEY", device)):
        if not 1 <= len(value) <= 511 or not re.fullmatch(r"[\x21-\x7e]+", value):
            raise ValueError(f"{name} must contain 1-511 visible ASCII characters without spaces.")
    if not ca.strip().startswith("-----BEGIN CERTIFICATE-----") or "-----END CERTIFICATE-----" not in ca:
        raise ValueError("--ca must contain the trusted root CA in PEM format.")
    if len(ca) > 16384:
        raise ValueError("The CA file is too large.")

    def literal(value):
        return '"' + ''.join(f'\\{byte:03o}' for byte in value.encode("ascii")) + '"'

    return ("#pragma once\n/* Local settings connection; do not share credentials or firmware. */\n"
            f"#define DEVICE_SETTINGS_HOST {literal(url.hostname)}\n"
            f"#define DEVICE_SETTINGS_API_KEY {literal(key)}\n"
            f"#define DEVICE_SETTINGS_CA_PEM {literal(ca)}\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", type=Path, default=Path(__file__).resolve().parent / ".env")
    parser.add_argument("--ca", type=Path, required=True)
    args = parser.parse_args()
    try:
        from dotenv import dotenv_values
        values = dotenv_values(args.env, interpolate=False)
        if not args.env.is_file():
            raise ValueError("The .env file was not found.")
        content = configuration(values, args.ca.read_text())
    except (ImportError, OSError, ValueError, UnicodeError) as error:
        parser.error(str(error) if not isinstance(error, ImportError) else "python-dotenv is required.")
    target = Path(__file__).resolve().parent / "device_config.h"
    fd, temporary = tempfile.mkstemp(dir=target.parent, prefix=".device-config-")
    try:
        with os.fdopen(fd, "w") as output:
            output.write(content)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print("本体設定の接続先を保存しました。configure_api.pyも同じ.envで実行し、ビルド・書き込みしてください。")


if __name__ == "__main__":
    main()
