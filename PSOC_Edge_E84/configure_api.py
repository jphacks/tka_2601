#!/usr/bin/env python3
"""Import API settings from PSOC_Edge_E84/.env without displaying secret values."""
import argparse
import os
from pathlib import Path
import re
import tempfile


def configuration(values):
    host = (values.get("DOOR_UI_HOSTNAME") or "door-ui.shionkk.f5.si").strip().lower()
    key = values.get("DOOR_API_KEY") or ""
    mode = values.get("DOOR_RELAY_MODE") or "omakase"
    device_key = values.get("DOOR_DEVICE_KEY") or ""
    if len(host) >= 128 or not all(
        re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
        for label in host.split(".")
    ):
        raise ValueError("DOOR_UI_HOSTNAME must be a hostname without a scheme, port or path.")
    if not 32 <= len(key) < 512 or not re.fullmatch(r"[A-Za-z0-9._~+/-]+=*", key):
        raise ValueError("DOOR_API_KEY must be a 32-511 character Bearer token.")
    if mode not in ("normal", "omakase", "away"):
        raise ValueError("DOOR_RELAY_MODE must be normal, omakase or away.")
    if device_key and (len(device_key) > 512 or not re.fullmatch(r"[\x21-\x7e]+", device_key)):
        raise ValueError("DOOR_DEVICE_KEY must contain 1-512 visible ASCII characters without spaces.")

    def literal(value):
        return '"' + ''.join(f'\\{byte:03o}' for byte in value.encode('ascii')) + '"'

    return ("#pragma once\n\n/* Local API credentials; do not share this file or firmware. */\n"
            f"#define DOOR_API_HOST {literal(host)}\n"
            f"#define DOOR_API_KEY {literal(key)}\n"
            f"#define DOOR_RELAY_MODE {literal(mode)}\n"
            f"#define DOOR_DEVICE_KEY {literal(device_key)}\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", type=Path,
                        default=Path(__file__).resolve().parent / ".env",
                        help="Settings file (default: .env next to this script, regardless of the working directory).")
    args = parser.parse_args()
    if not args.env.is_file():
        parser.error("The .env file was not found. Create PSOC_Edge_E84/.env from .env.example, or specify --env.")
    try:
        from dotenv import dotenv_values
    except ImportError:
        parser.error("python-dotenv is required: python3 -m pip install python-dotenv")
    try:
        values = dotenv_values(args.env, interpolate=False)
        content = configuration(values)
    except ValueError as error:
        parser.error(str(error))
    target = Path(__file__).resolve().parent / "source" / "api_config.h"
    fd, temporary = tempfile.mkstemp(dir=target.parent, prefix=".api-config-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            output.write(content)
        os.replace(temporary, target)
        # An earlier build without api_config.h cannot list it in its .d file:
        # __has_include skipped that include. Invalidate the always-included
        # wrapper so the first saved configuration also reaches the firmware.
        os.utime(target.with_name("api_settings.h"), None)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(".envからAPI設定を保存しました（キーは非表示）。次に make -j8 program を実行してください。")
    if not (values.get("DOOR_DEVICE_KEY") or ""):
        print("DOOR_DEVICE_KEYが未設定です。既定のv1通話は診断用IDで試せますが、住人設定・履歴保存には登録済みの鍵が必要です。v2通話は鍵の設定が必要です。")


if __name__ == "__main__":
    main()
