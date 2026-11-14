#!/usr/bin/env python3
"""Pair E84 and M5Stack Basic on Wi-Fi, without printing credentials."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import tempfile

PRIVATE_NETWORKS = tuple(ipaddress.ip_network(network) for network in
                         ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
DEFAULT_PORT = 8768


def configuration(host, port, token):
    if not isinstance(host, str):
        raise ValueError("Use a literal private IPv4 address, without a port or URL.")
    try:
        address = ipaddress.IPv4Address(host)
    except ipaddress.AddressValueError:
        raise ValueError("Use a literal private IPv4 address, without a port or URL.") from None
    if not any(address in network for network in PRIVATE_NETWORKS) or address.packed[-1] in (0, 255):
        raise ValueError("Use a private LAN host address; .0 and .255 are not accepted.")
    if type(port) is not int or not 1024 <= port <= 65534:
        raise ValueError("The UDP port must be 1024..65534; streaming TCP uses port + 1.")
    if not isinstance(token, str) or re.fullmatch(r"[0-9a-f]{64}", token) is None:
        raise ValueError("The shared token must be 64 lowercase hexadecimal characters.")
    return {"host": str(address), "port": port, "token": token}


def atomic_private_write(target, content):
    fd, temporary = tempfile.mkstemp(dir=target.parent, prefix=".m5-config-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            output.write(content)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def wifi_credentials(path):
    """Read only the fixed-width octal literals emitted by configure_wifi.py."""
    text = path.read_text(encoding="utf-8")
    values = {}
    for name in ("WIFI_SSID", "WIFI_PASSWORD"):
        definitions = re.findall(r"^\s*#\s*define\s+" + name + r"\b([^\n]*)$", text, re.MULTILINE)
        if len(definitions) != 1:
            raise ValueError("Wi-Fi設定を configure_wifi.py で保存し直してください。設定は変更していません。")
        literal = re.fullmatch(r'\s*"((?:\\[0-3][0-7]{2})*)"\s*', definitions[0])
        if literal is None:
            raise ValueError("Wi-Fi設定は configure_wifi.py で生成した形式が必要です。設定は変更していません。")
        encoded = bytes(int(item, 8) for item in re.findall(r"\\([0-3][0-7]{2})", literal.group(1)))
        try:
            values[name] = encoded.decode("utf-8")
        except UnicodeError:
            raise ValueError("Wi-Fi設定の文字コードが不正です。設定は変更していません。") from None
    ssid, password = values["WIFI_SSID"], values["WIFI_PASSWORD"]
    if "\0" in ssid or not 1 <= len(ssid.encode("utf-8")) <= 32:
        raise ValueError("SSIDは1〜32バイトで設定してください。設定は変更していません。")
    if not 8 <= len(password) <= 63 or any(not 32 <= ord(char) <= 126 for char in password):
        raise ValueError("Wi-Fiパスワードは半角英数・記号の8〜63文字が必要です。設定は変更していません。")
    return ssid, password


def c_literal(value):
    return '"' + ''.join(f'\\{byte:03o}' for byte in value.encode("utf-8")) + '"'


def receiver_configuration(ssid, password, port, token):
    return ("#pragma once\n/* Private M5 link settings. Do not commit or share firmware. */\n"
            f"#define M5_LINK_WIFI_SSID {c_literal(ssid)}\n"
            f"#define M5_LINK_WIFI_PASSWORD {c_literal(password)}\n"
            f"#define M5_LINK_PORT {port}u\n"
            f'#define M5_LINK_TOKEN "{token}"\n')


def existing_configuration(path):
    if not path.exists():
        return {}
    try:
        values = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(values, dict):
            raise ValueError
        # A receiver can be prepared before DHCP assigns its address.
        checked = configuration(values.get("host", "192.168.1.1"), values["port"], values["token"])
        return {key: checked[key] for key in ("host", "port", "token") if key in values}
    except (KeyError, TypeError, ValueError, UnicodeError):
        raise ValueError("既存の .m5-link.json が不正です。設定は変更していません。") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare-receiver", action="store_true",
                        help="Prepare M5Stack Basic using the E84 Wi-Fi settings, before its IP is known")
    parser.add_argument("--host", help="M5 or test listener's private LAN IPv4")
    parser.add_argument("--port", type=int, help="UDP port 1024..65534; TCP uses port + 1 (default: existing setting, or 8768)")
    parser.add_argument("--token-file", type=Path,
                        help="Explicitly replace the token with this file; otherwise reuse the existing token")
    args = parser.parse_args()
    if not args.prepare_receiver and args.host is None:
        parser.error("Specify --prepare-receiver first, or --host with the receiver's IPv4 address.")
    root = Path(__file__).resolve().parent
    receiver = root.parent / "M5Stack_Basic_E84_Link" / "link_config.h"
    try:
        old = existing_configuration(root / ".m5-link.json")
        token = (args.token_file.read_text(encoding="ascii").strip() if args.token_file
                 else old.get("token") or secrets.token_hex(32))
        port = args.port if args.port is not None else old.get("port", DEFAULT_PORT)
        host = args.host if args.host is not None else old.get("host")
        values = configuration("192.168.1.1" if host is None else host, port, token)
        if host is None:
            del values["host"]
        receiver_text = None
        receiver_changed = False
        if args.prepare_receiver or receiver.exists():
            ssid, password = wifi_credentials(root / "source" / "wifi_config.h")
            receiver_text = receiver_configuration(ssid, password, port, token)
            if not receiver.parent.is_dir():
                raise ValueError("隣の M5Stack_Basic_E84_Link ディレクトリが見つかりません。設定は変更していません。")
            receiver_changed = not receiver.exists() or receiver.read_bytes() != receiver_text.encode("utf-8")
        if host is not None and not (root / "source" / "m5_settings.h").is_file():
            raise ValueError("source/m5_settings.h が見つかりません。プロジェクトを確認してください。設定は変更していません。")
    except (OSError, UnicodeError, ValueError) as error:
        parser.error(str(error) if isinstance(error, ValueError) and not isinstance(error, UnicodeError)
                     else "設定ファイルを読み込めません。Wi-Fi設定・トークンファイルを確認してください。設定は変更していません。")
    try:
        # Validate every input before replacing any existing private file.
        if receiver_text is not None:
            atomic_private_write(receiver, receiver_text)
        if host is not None:
            header = ("#pragma once\n/* Private M5 link settings. Do not commit or share firmware. */\n"
                      f'#define M5_IPV4 "{values["host"]}"\n'
                      f'#define M5_PORT {port}u\n'
                      f'#define M5_TOKEN "{token}"\n')
            atomic_private_write(root / "source" / "m5_config.h", header)
            # A build done before this optional header existed has no dependency
            # on it. Touch the always-included wrapper to invalidate that build.
            os.utime(root / "source" / "m5_settings.h", None)
        atomic_private_write(root / ".m5-link.json", json.dumps(values, indent=2) + "\n")
    except OSError:
        parser.error("設定を保存できません。書き込み権限を確認して、同じコマンドを再実行してください。")
    print("M5 連携設定を保存しました（SSID・パスワード・トークンは非表示）。")
    if receiver_text is not None:
        if receiver_changed:
            print("M5Stack_Basic_E84_Link/link_config.h を更新しました。M5側をビルド・書き込みしてください。")
        else:
            print("M5側の設定内容は同じです。IPだけの変更ならM5の再書き込みは不要です。")
    if host is not None:
        print("E84側は make -j8 program で反映後、UARTで t を押して往復通信を確認できます。")
    else:
        print("M5画面に出たIPを python3 configure_m5.py --host <M5のIP> で設定してください。")


if __name__ == "__main__":
    main()
