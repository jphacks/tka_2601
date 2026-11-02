"""On-demand checks of the actual board; never infer radio success from USB."""
from datetime import datetime
import ipaddress
import json
import re
import threading
import time
import uuid
from zoneinfo import ZoneInfo


CHECKS = {
    'usb': ('Mac ↔ XIAO（USB）', 'USBの診断コマンドへの応答と本体設定の読み戻しを確認します。'),
    'wifi': ('XIAOのWi-Fi接続', 'AP接続、IP取得、電波強度を本体へ問い合わせます。'),
    'api_https': ('XIAO ↔ API（HTTPS）', '証明書・API認証・/api/statusの応答を確認します。'),
    'api_wss': ('XIAO ↔ API（WebSocket）', '音声用WebSocketの認証・READY・往復応答を確認します。'),
    'speaker': ('XIAOのスピーカー', '1 kHzのトーンを1秒鳴らします。音が聞こえるかは耳で確認してください。'),
    'loopback': ('マイク → スピーカー', '3秒録音して、そのまま再生します。保存はしません。'),
}
BLOCKED_DURING_CALL = {'api_https', 'api_wss', 'speaker', 'loopback'}


class DiagnosticBusy(Exception):
    pass


class Diagnostics:
    def __init__(self, link):
        self.link = link
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
                    'voice_active': self.link.snapshot()['voice_active'],
                    'recovery_required': self.link.snapshot().get('recovery_required', False),
                    'results': {key: value.copy() for key, value in self.results.items()}}

    def start(self, key):
        if key not in CHECKS:
            raise ValueError('不明な診断項目です。')
        with self.lock:
            if self.closed or self.running:
                raise DiagnosticBusy('別の通信診断が実行中です。完了してから確認してください。')
            if key in BLOCKED_DURING_CALL and self.link.snapshot()['voice_active']:
                raise DiagnosticBusy('通話中はこの診断を実行できません。通話終了後に確認してください。')
            self.running = key
            self.revision += 1
            self.results[key].update(state='running', detail='実機からの応答を待っています…', checked_at=None, duration_ms=None)
            threading.Thread(target=self._worker, args=(key,), daemon=True).start()
            return self.snapshot()

    def _worker(self, key):
        started = time.monotonic()
        self.link.record('[診断] '+CHECKS[key][0]+'：開始')
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
        self.link.record('[診断] '+CHECKS[key][0]+'：'+{'ok':'成功','failed':'失敗','blocked':'実行できません','warning':'一部未準備'}[state]+'：'+detail)

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
        return 'ok', detail+'。データの往復はHTTPS・WebSocketの項目で確認できます。'

    def _run(self, key):
        if key == 'usb':
            _, line = self.link.exchange('u', lambda t: t.startswith('[DIAG] usb '), 5)
            if 'ok=1' not in line:
                return 'failed', 'XIAOのUSB診断応答が不正です。'
            reply = self.link.command('@get')
            if reply.get('ok') is not True or not isinstance(reply.get('saved'), dict):
                raise ValueError('XIAOから設定読み戻しの正常応答がありません。')
            return 'ok', 'XIAOのUSB診断応答・本体設定の読み戻しに成功しました。'
        if key == 'wifi':
            _, line = self.link.exchange('n', lambda t: t.startswith('[DIAG] wifi '), 8)
            return self.wifi_result(json.loads(line[len('[DIAG] wifi '):]))
        if key == 'api_https':
            lines, line = self.link.exchange('a', lambda t: t.startswith('[DIAG] api_https ') and t != '[DIAG] api_https checking', 70)
            if line.endswith('busy') or line.endswith('already_running'):
                return 'blocked', '通話・別のAPI診断が終了してから確認してください。'
            if line != '[DIAG] api_https ok=1':
                return 'failed', 'XIAOからAPIへのHTTPS通信・認証に失敗しました。直前のDNS/TLS/HTTPログを確認してください。'
            for item in reversed(lines):
                match = re.search(r'\[SERVER\] /api/status HTTP 200; body \(\d+ bytes\): (.*)', item['text'])
                if match:
                    body = json.loads(match[1])
                    if body.get('ready') is False:
                        return 'warning', 'HTTPS・API認証・HTTP 200は成功しましたが、音声サービスに未準備の項目があります。'
                    break
            return 'ok', 'XIAOで証明書を検証し、API認証付き /api/status のHTTP 200応答を確認しました。'
        if key == 'api_wss':
            _, line = self.link.exchange('w', lambda t: t.startswith('[API WSS] ') and 'checking;' not in t, 85)
            if line.startswith('[API WSS] OK:'):
                return 'ok', '音声用WebSocketのTLS・API認証・READY・PING/PONGに成功しました。会話は開始していません。'
            if line == '[API WSS] busy':
                return 'blocked', '通話終了後に確認してください。'
            return 'failed', '音声用WebSocketの接続・認証・READY応答に失敗しました。実機ログを確認してください。'
        if key == 'speaker':
            _, line = self.link.exchange('t', lambda t: t.startswith('[DIAG] speaker ') and t != '[DIAG] speaker playing', 8)
            if line == '[DIAG] speaker busy':
                return 'blocked', '通話や別の音声処理が終了してから確認してください。'
            if line == '[DIAG] speaker ok=1':
                return 'ok', 'トーンの出力が完了しました。音が聞こえなければ配線と音量を確認してください。'
            return 'failed', 'スピーカーへの出力に失敗しました：'+line.removeprefix('[DIAG] speaker ok=0 ').removeprefix('[DIAG] speaker ')
        if key == 'loopback':
            _, line = self.link.exchange('l', lambda t: t.startswith('[DIAG] loopback ') and
                t not in ('[DIAG] loopback recording', '[DIAG] loopback playing'), 15)
            if line == '[DIAG] loopback busy':
                return 'blocked', '通話や別の音声処理が終了してから確認してください。'
            if line == '[DIAG] loopback ok=1':
                return 'ok', '録音と再生が完了しました。自分の声が聞こえたかを確認してください。'
            return 'failed', 'マイクの録音またはスピーカーへの再生に失敗しました：'+line.removeprefix('[DIAG] loopback ok=0 ').removeprefix('[DIAG] loopback ')
        raise ValueError('不明な診断項目です。')

    def close(self):
        with self.lock:
            self.closed = True
