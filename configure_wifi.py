#!/usr/bin/env python3
"""Set this test's Wi-Fi credentials locally, without printing the password."""
import getpass
import os
from pathlib import Path
import tempfile


def c_literal(value):
    # Fixed-width octal escapes preserve UTF-8 bytes, quotes and backslashes.
    return '"' + ''.join(f'\\{byte:03o}' for byte in value.encode('utf-8')) + '"'


def main():
    print('2.4 GHzの家庭用Wi-Fiを設定します。暗号化方式は基板が自動判定します。')
    print('パスワードは入力中も表示されません。チャットへの貼り付けは不要です。')
    ssid = input('Wi-Fi名 (SSID): ')
    password = getpass.getpass('Wi-Fiパスワード: ')
    if '\0' in ssid or not 1 <= len(ssid.encode('utf-8')) <= 32:
        raise SystemExit('SSIDは1〜32バイトで入力してください。設定は変更していません。')
    if not 8 <= len(password) <= 63 or any(not 32 <= ord(c) <= 126 for c in password):
        raise SystemExit('このテストではパスワードは半角英数・記号の8〜63文字です。設定は変更していません。')
    if password != getpass.getpass('確認のためもう一度: '):
        raise SystemExit('パスワードが一致しません。設定は変更していません。')
    target = Path(__file__).resolve().parent / 'source' / 'wifi_config.h'
    text = ('#pragma once\n\n/* Local credentials; do not share this file. */\n'
            f'#define WIFI_SSID {c_literal(ssid)}\n'
            f'#define WIFI_PASSWORD {c_literal(password)}\n')
    # mkstemp creates a file readable only by this macOS user (mode 0600).
    fd, temporary = tempfile.mkstemp(dir=target.parent, prefix='.wifi-config-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as output:
            output.write(text)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print('設定しました。次に make -j8 program を実行してください。')


if __name__ == '__main__':
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        raise SystemExit('\n中止しました。')
