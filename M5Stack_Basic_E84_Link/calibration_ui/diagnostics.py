"""On-demand checks of the actual boards; never infer radio success from USB."""
from datetime import datetime
import ipaddress
import json
import re
import threading
import time
import uuid
from zoneinfo import ZoneInfo


CHECKS = {
    'm5_usb': ('Mac ↔ M5（USB）', 'USBで本体設定を読み戻します。'),
    'e84_usb': ('Mac ↔ E84（USB）', 'USBの診断コマンドへの応答を確認します。'),
    'm5_wifi': ('M5のWi-Fi接続', 'AP接続、IP取得、電波強度を本体へ問い合わせます。'),
    'e84_wifi': ('E84のWi-Fi接続', 'AP接続、IP取得、電波強度を本体へ問い合わせます。'),
    'm5_udp': ('E84 ↔ M5（UDP）', 'Wi-Fi経由の認証済みPING/PONGを確認します。'),
    'm5_tcp': ('E84 ↔ M5（音声用TCP）', '音声用接続の認証と往復応答を確認します。'),
    'api_https': ('E84 ↔ API（HTTPS）', '証明書・API認証・/api/statusの応答を確認します。'),
    'api_wss': ('E84 ↔ API（WebSocket）', '音声用WebSocketの認証・READY・往復応答を確認します。'),
}
NETWORK_CHECKS = {'m5_udp', 'm5_tcp', 'api_https', 'api_wss'}


class DiagnosticBusy(Exception):
    pass


class Diagnostics:
    def __init__(self, bridge, monitor):
        self.bridge, self.monitor = bridge, monitor
        self.lock = threading.RLock()
        self.running = None
        self.closed = False
        self.revision = 0
        self.epoch = uuid.uuid4().hex
        self.results = {key: {'label': label, 'description': description, 'state': 'idle',
                              'detail': '未確認', 'checked_at': None, 'duration_ms': None}
                        for key, (label, description) in CHECKS.items()}

    def snapshot(self):
        with self.lock:
            return {'ok': True, 'running': self.running, 'revision': self.revision, 'epoch': self.epoch,
                    'voice_active': self.monitor.snapshot()['voice_active'],
                    'recovery_required': self.monitor.snapshot().get('recovery_required', False),
                    'results': {key: value.copy() for key, value in self.results.items()}}

    def start(self, key):
        if key not in CHECKS:
            raise ValueError('不明な診断項目です。')
        with self.lock:
            if self.closed or self.running:
                raise DiagnosticBusy('別の通信診断が実行中です。完了してから確認してください。')
            if key in NETWORK_CHECKS and self.monitor.snapshot()['voice_active']:
                raise DiagnosticBusy('通話中はこの診断を実行できません。通話終了後に確認してください。')
            self.running = key
            self.revision += 1
            self.results[key].update(state='running', detail='実機からの応答を待っています…', checked_at=None, duration_ms=None)
            threading.Thread(target=self._worker, args=(key,), daemon=True).start()
            return self.snapshot()

    def _worker(self, key):
        started = time.monotonic()
        self.monitor.record('[診断] '+CHECKS[key][0]+'：開始')
        try:
            state, detail = self._run(key)
        except (OSError, TimeoutError, ValueError) as error:
            state, detail = 'failed', str(error)
        except Exception:
            state, detail = 'failed', '診断処理に失敗しました。実機ログを確認してください。'
        with self.lock:
            self.results[key].update(state=state, detail=detail,
                checked_at=datetime.now(ZoneInfo('Asia/Tokyo')).isoformat(timespec='seconds'),
                duration_ms=round((time.monotonic()-started)*1000))
            self.running = None
            self.revision += 1
        self.monitor.record('[診断] '+CHECKS[key][0]+'：'+{'ok':'成功','failed':'失敗','blocked':'実行できません','warning':'一部未準備'}[state]+'：'+detail)

    @staticmethod
    def wifi_result(data):
        try:
            has_ip = int(ipaddress.IPv4Address(data.get('ip', ''))) != 0
        except ipaddress.AddressValueError:
            has_ip = False
        if data.get('connected') is not True or not has_ip:
            return 'failed', 'Wi-Fi未接続、またはIPアドレスを取得できていません。'
        detail = f"AP接続・IP取得済み：{data['ip']} ／ ゲートウェイ {data.get('gateway', '不明')}"
        if type(data.get('rssi')) is int and data.get('rssi_valid', True):
            detail += f" ／ 電波強度 {data['rssi']} dBm"
        return 'ok', detail+'。データの往復はUDP/TCPの項目で確認できます。'

    def _run(self, key):
        if key == 'm5_usb':
            reply = self.bridge.command('@get')
            if reply.get('ok') is not True or not isinstance(reply.get('saved'), dict):
                raise ValueError('M5から設定読み戻しの正常応答がありません。')
            return 'ok', 'M5のUSB応答・本体設定の読み戻しに成功しました。'
        if key == 'm5_wifi':
            reply = self.bridge.command('@net')
            if reply.get('diagnostic') != 'wifi':
                raise ValueError('M5のWi-Fi診断に未対応です。本体ファームウェアを更新してください。')
            return self.wifi_result(reply)
        if key == 'e84_usb':
            _, line = self.monitor.exchange('u', lambda t: t.startswith('[DIAG] usb '), 5)
            return ('ok', 'E84のUSB診断コマンドへの応答を確認しました。') if 'ok=1' in line else ('failed', 'E84のUSB診断応答が不正です。')
        if key == 'e84_wifi':
            _, line = self.monitor.exchange('n', lambda t: t.startswith('[DIAG] wifi '), 8)
            return self.wifi_result(json.loads(line[len('[DIAG] wifi '):]))
        if key == 'm5_udp':
            _, line = self.monitor.exchange('t', lambda t: t.startswith(('[M5] PONG received.',
                '[M5] No authenticated reply', '[M5] Diagnostic UDP receive failed', '[M5] Cannot ',
                '[M5] Wi-Fi is not ready', '[M5] Configure ', '[M5] Test skipped:')), 8)
            if line.startswith('[M5] PONG received.'):
                return 'ok', 'E84 → M5 → E84 の認証済みUDP応答を受信しました。'
            return 'failed', '認証済みUDP応答がありません。両ボードのWi-Fi、IP設定と実機ログを確認してください。'
        if key == 'm5_tcp':
            _, line = self.monitor.exchange('v', lambda t: t.startswith('[M5 TCP] ') and 'Checking ' not in t or
                t.startswith('[VOICE] Wi-Fi, clock, API or M5 configuration not ready.'), 18)
            if line.startswith('[M5 TCP] OK:'):
                return 'ok', '音声用TCPのHELLO/READY認証とPING/PONGに成功しました。'
            if 'not_accepted' in line:
                return 'blocked', 'M5が接続を受け付けませんでした。角度調整は保存または取消し、ボタンテストの完了後に確認してください。'
            return 'failed', '音声用TCPの接続・認証・往復応答に失敗しました。実機ログを確認してください。'
        if key == 'api_https':
            lines, line = self.monitor.exchange('a', lambda t: t.startswith('[DIAG] api_https ') and t != '[DIAG] api_https checking', 70)
            if line.endswith('busy') or line.endswith('already_running'):
                return 'blocked', '通話・別のAPI診断が終了してから確認してください。'
            if line != '[DIAG] api_https ok=1':
                return 'failed', 'E84からAPIへのHTTPS通信・認証に失敗しました。直前のDNS/TLS/HTTPログを確認してください。'
            for item in reversed(lines):
                match = re.search(r'\[SERVER\] /api/status HTTP 200; body \(\d+ bytes\): (.*)', item['text'])
                if match:
                    body = json.loads(match[1])
                    if body.get('ready') is False:
                        return 'warning', 'HTTPS・API認証・HTTP 200は成功しましたが、音声サービスに未準備の項目があります。'
                    break
            return 'ok', 'E84で証明書を検証し、API認証付き /api/status のHTTP 200応答を確認しました。'
        if key == 'api_wss':
            _, line = self.monitor.exchange('w', lambda t: t.startswith('[API WSS] ') and 'checking;' not in t, 85)
            if line.startswith('[API WSS] OK:'):
                return 'ok', '音声用WebSocketのTLS・API認証・READY・PING/PONGに成功しました。会話は開始していません。'
            if line == '[API WSS] busy':
                return 'blocked', '通話終了後に確認してください。'
            return 'failed', '音声用WebSocketの接続・認証・READY応答に失敗しました。実機ログを確認してください。'
        raise ValueError('不明な診断項目です。')

    def close(self):
        with self.lock:
            self.closed = True
