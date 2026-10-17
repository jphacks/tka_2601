#!/usr/bin/env python3
"""Create private WAV upload settings from environment variables and a CA file."""
import argparse
import os
from pathlib import Path
import re
import tempfile


def configuration(host, token, ca):
    host = host.strip().lower()
    if not host or len(host) >= 128 or not all(
        re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", part)
        for part in host.split(".")
    ):
        raise ValueError("AUDIO_UPLOAD_HOST must be a hostname, without scheme, port or path.")
    if not 32 <= len(token) < 512 or not re.fullmatch(r"[A-Za-z0-9._~+/-]+=*", token):
        raise ValueError("AUDIO_RECEIVER_TOKEN must be a 32-511 character Bearer token.")
    if (not ca.isascii() or "-----BEGIN CERTIFICATE-----" not in ca or
            "-----END CERTIFICATE-----" not in ca or "PRIVATE KEY" in ca or len(ca) > 16384):
        raise ValueError("--ca must contain PEM root certificate(s), not a private key.")

    def literal(value):
        return '"' + ''.join(f'\\{byte:03o}' for byte in value.encode('ascii')) + '"'

    return ("#pragma once\n/* Local settings. Do not share this file or firmware. */\n"
            f"#define AUDIO_UPLOAD_HOST {literal(host)}\n"
            f"#define AUDIO_UPLOAD_TOKEN {literal(token)}\n"
            f"#define AUDIO_UPLOAD_CA_PEM {literal(ca)}\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ca", required=True, type=Path, help="HTTPS server's trusted PEM root CA")
    args = parser.parse_args()
    try:
        content = configuration(os.environ.get("AUDIO_UPLOAD_HOST", ""),
                                os.environ.get("AUDIO_RECEIVER_TOKEN", ""),
                                args.ca.read_text(encoding="ascii"))
    except (ValueError, OSError) as error:
        parser.error(str(error))
    target = Path(__file__).resolve().parent / "source/upload_config.h"
    fd, temporary = tempfile.mkstemp(dir=target.parent, prefix=".upload-config-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            output.write(content)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print("録音送信設定を保存しました（トークンは非表示）。再ビルドして書き込んでください。")


if __name__ == "__main__":
    main()
