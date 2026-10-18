#!/usr/bin/env python3
"""Local slider UI for M5 USB servo calibration (Python standard library only)."""
import argparse
from collections import deque
from datetime import datetime
import glob
import json
import os
import re
import signal
from pathlib import Path
import select
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs
import uuid
from zoneinfo import ZoneInfo
from conversation_history import ConversationHistory
from diagnostics import Diagnostics, DiagnosticBusy


class E84Monitor:
    """One persistent UART reader. Web clients only read its bounded RAM log."""
    def __init__(self, port=None, history_path=None):
        self.port = port
        self.fd = None
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.stop = threading.Event()
        self.lines = deque(maxlen=500)
        self.sequence = 0
        self.epoch = uuid.uuid4().hex
        self.connected = False
        self.stage = 'E84を接続しています'
        self.voice_active = False
        self.recovery_required = False
        self.link_state = 'unknown'
        self.link_detail = '「UDP疎通を確認」「音声用TCPを確認」で往復の応答を確認できます。'
        self.link_updated = None
        self.link_last_ok = None
        self.link_last_ok_tick = None
        self.calibration_active = None
        self.history = ConversationHistory(history_path)
        self.worker = threading.Thread(target=self.run, daemon=True)
        self.worker.start()

    def link_event(self, text):
        state = detail = event = None
        if text.startswith(('[M5 MODE] calibration=active', '[M5 USB] [STREAM] USB angle calibration;')):
            self.calibration_active = True
        elif text.startswith(('[M5 MODE] calibration=idle', '[M5 USB] [STREAM] Servo angles saved',
                              '[M5 USB] [STREAM] Calibration cancelled', '[M5 USB] [STREAM] Calibration timed out')):
            self.calibration_active = False
            if self.link_state == 'blocked':
                state, detail = 'unknown', '角度調整を終了しました。「音声用TCPを確認」で接続を再確認できます。'
        elif text.startswith('[M5 TCP] Checking '):
            state, detail = 'checking', '音声用TCPの認証と往復応答を確認中です。ボタンや音声出力は動かしません。'
        elif text.startswith('[M5 TCP] OK:'):
            state, detail = 'confirmed', '音声用TCP：E84とM5の認証・往復応答に成功しました。'
        elif text.startswith(('[M5 TCP] not_accepted', '[VOICE] Call ending: reason=m5_auth_failed')):
            state, detail = 'blocked', ('角度調整中のためM5は音声用TCPを受け付けません。本体に保存または取消してください。'
                if self.calibration_active else '音声用TCPの受付・認証前に切断されました。調整・テスト状態と直前のログを確認してください。')
        elif text.startswith(('[M5 TCP] connect_failed', '[M5 TCP] pong_missing')):
            state, detail = 'failed', '音声用TCPに接続できないか、認証後の往復応答がありません。'
        elif text.startswith('[M5] Testing '):
            state, detail = 'checking', 'E84からM5へ送信しました。認証済みの応答を待っています。'
        elif text.startswith('[M5] PONG received.'):
            state, detail = 'confirmed', 'E84 → M5 → E84 の認証済み応答を受信しました（UDP）。'
        elif text.startswith(('[M5] No authenticated reply', '[M5] Diagnostic UDP receive failed',
                              '[M5] Cannot allocate', '[M5] Cannot prepare')):
            state, detail = 'failed', 'E84でM5からの認証済み応答を確認できませんでした。'
        elif text.startswith('[M5 USB] [LINK] Ping received; pong sent.'):
            event = 'M5がE84の確認要求を受信し、応答を送信しました。E84側の受信結果で往復を判定します。'
        elif text.startswith('[M5 USB] [LINK] Chime received.'):
            event = 'チャイム連携：M5がE84からのチャイム通知を受信しました。'
        elif text.startswith('[M5 USB] [STREAM] E84 authenticated'):
            event = '音声接続：M5がE84を認証しました（TCP）。'
        elif text.startswith('[VOICE] Call button operation complete'):
            state, detail = 'confirmed', 'E84がM5の通話ボタン操作完了の応答を受信しました（TCP）。'
        elif text.startswith('[VOICE] M5 playback complete:'):
            state, detail = 'confirmed', 'E84がM5の音声再生完了の応答を受信しました（TCP）。'
        elif text.startswith(('[BOOT] Network task running', '[Wi-Fi] Connection lost', '[M5 USB] [BOOT]')) or (
            text.startswith(('[M5 USB] [Wi-Fi] Disconnected', '[M5 USB] [Wi-Fi] Connected.'))
        ):
            state, detail = 'unknown', '本体の再起動・Wi-Fi再接続後の連携は未確認です。'
        elif text.startswith('[VOICE] Call ending: reason=m5_'):
            state, detail = 'failed', 'E84とM5の通話用通信でエラーが発生しました。直前のログを確認してください。'
        if state:
            self.link_state, self.link_detail = state, detail
            self.link_updated = datetime.now(ZoneInfo('Asia/Tokyo')).strftime('%H:%M:%S')
            if state == 'confirmed':
                self.link_last_ok, self.link_last_ok_tick = self.link_updated, time.monotonic()
            labels = {'unknown': '連携未確認', 'checking': '連携確認中', 'confirmed': '連携確認済み', 'failed': '応答なし・通信エラー', 'blocked': '音声用TCPの受付・認証で停止'}
            event = labels[state]+'：'+detail
        return event

    def append_line(self, text):
        self.sequence += 1
        self.lines.append({'id': self.sequence, 'time': datetime.now(ZoneInfo('Asia/Tokyo')).strftime('%H:%M:%S'), 'text': text})

    def record(self, text):
        text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text).strip('\r\n')
        if not text:
            return
        with self.lock:
            self.history.record(text)
            if any(marker in text for marker in ('Preparing streaming call', 'Listening:', 'Response ')):
                self.voice_active = True
            elif any(marker in text for marker in ('[BOOT] Network task running', 'Call ended;', 'Call stopped;')):
                self.voice_active = False
                self.recovery_required = False
            if 'Playback/call state uncertain' in text:
                self.recovery_required = True
                # New firmware explicitly releases network resources before this log.
                # Old firmware keeps busy latched, so preserve its diagnostic guard.
                self.voice_active = 'Diagnostics available.' not in text
            self.append_line(text)
            event = self.link_event(text)
            if event:
                self.append_line('[E84↔M5] '+event)
            for marker, stage in [
                ('[DETECTED]', 'チャイムを検知しました'),
                ('[BOOT] Network task running', 'E84起動中・ネットワーク接続待ち'),
                ('Authenticated HTTPS status check passed', 'チャイム待機中（Wi-Fi・サーバー接続OK）'),
                ('Preparing streaming call', 'M5に接続中'),
                ('Waiting for one call-button', '設定した時間を待ち、通話ボタンを1回押して戻します'),
                ('CALL waiting', '通話ボタンを押す前の待機中'),
                ('CALL press once:', '通話ボタンを1回押しています'),
                ('CALL returning', '通話ボタンを待機位置へ戻しています'),
                ('CALL released;', '通話ボタンの復帰完了'),
                ('Server ready:', 'サーバー接続完了'),
                ('Call button operation complete', '通話ボタン操作完了・agentに接続中'),
                ('Response 0:', 'M5で挨拶を再生中'),
                ('Response ', 'M5で返答を再生中'),
                ('Output ended:', 'M5の再生完了を待機'),
                ('M5 playback complete:', 'M5の再生完了'),
                ('Listening:', '聞き取り中：E84のマイクに話してください'),
                ('Input streaming:', 'E84マイクの音声を送信中'),
                ('Input complete:', '発話を送信しました・返答待ち'),
                ('Call ended;', '会話終了・次のチャイムを待機'),
                ('Call stopped;', '通話停止・次のチャイムを待機'),
                ('Playback/call state uncertain', '通話エラー・終了状態の確認が必要です'),
            ]:
                if marker in text:
                    if marker == 'Authenticated HTTPS status check passed' and self.voice_active:
                        break
                    self.stage = stage
                    break
            self.changed.notify_all()

    def snapshot(self, after=0):
        with self.lock:
            if after > self.sequence:
                after = 0
            age = None if self.link_last_ok_tick is None else max(0, int(time.monotonic()-self.link_last_ok_tick))
            state, detail = self.link_state, self.link_detail
            if state == 'confirmed' and age is not None and age >= 60:
                state, detail = 'stale', '前回の成功から60秒以上経過しています。現在の疎通は再確認してください。'
            if not self.connected:
                state, detail = 'unknown', 'E84のUSBログが未接続のため、現在の連携状態を確認できません。'
            return {'ok': True, 'connected': self.connected, 'port': self.port,
                    'voice_active': self.voice_active, 'recovery_required': self.recovery_required,
                    'calibration_active': self.calibration_active,
                    'board_link': {'state': state, 'detail': detail, 'updated_at': self.link_updated,
                                   'last_success_at': self.link_last_ok, 'last_success_age_seconds': age},
                    'epoch': self.epoch, 'stage': self.stage, 'next': self.sequence,
                    'lines': [line.copy() for line in self.lines if line['id'] > after]}

    def send(self, command):
        if command not in ('s', 't', 'v', 'e', 'q', 'u', 'n', 'a', 'w'):
            raise ValueError('使用できないE84コマンドです。')
        with self.lock:
            if self.fd is None:
                raise OSError('E84がUSB接続されていません。')
            os.write(self.fd, command.encode('ascii'))
        self.record(f'[WEB] {command}: '+{'s': '状態確認', 't': 'UDP疎通確認', 'v': '音声用TCPの認証確認', 'e': 'チャイム検知を再待機', 'q': '通話終了要求',
            'u': 'E84 USB応答確認', 'n': 'E84 Wi-Fi確認', 'a': 'API HTTPS確認', 'w': 'API WebSocket確認'}[command])
        return {'ok': True}

    def exchange(self, command, predicate, timeout):
        with self.changed:
            after = self.sequence
            self.send(command)
            deadline = time.monotonic()+timeout
            while True:
                lines = [line.copy() for line in self.lines if line['id'] > after]
                for line in lines:
                    if predicate(line['text']):
                        return lines, line['text']
                if not self.connected or self.stop.is_set():
                    raise OSError('E84のUSB接続が切れました。')
                if any('[BOOT] Network task running' in line['text'] for line in lines):
                    raise OSError('診断中にE84が再起動しました。起動後に再確認してください。')
                remaining = deadline-time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('E84の診断コマンドに応答がありません。USB接続と対応ファームウェアを確認してください。')
                self.changed.wait(min(remaining, .5))

    def run(self):
        while not self.stop.is_set():
            fd = None
            original = None
            try:
                ports = [self.port] if self.port else glob.glob('/dev/cu.usbmodem*')
                if len(ports) != 1:
                    raise OSError('E84のUSBポートを1台だけ接続してください。')
                fd = os.open(ports[0], os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
                original = termios.tcgetattr(fd)
                attrs = termios.tcgetattr(fd)
                attrs[0] = attrs[1] = attrs[3] = 0
                attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
                attrs[4] = attrs[5] = termios.B115200
                attrs[6][termios.VMIN] = attrs[6][termios.VTIME] = 0
                termios.tcsetattr(fd, termios.TCSANOW, attrs)
                termios.tcflush(fd, termios.TCIFLUSH)
                with self.lock:
                    self.fd = fd
                    self.port = ports[0]
                    self.connected = True
                    self.stage = 'E84接続済み・チャイムを待機'
                self.record('[MONITOR] E84 UART connected: '+ports[0])
                self.send('s')
                buffer = bytearray()
                while not self.stop.is_set():
                    if not select.select([fd], [], [], .2)[0]:
                        continue
                    data = os.read(fd, 8192)
                    if not data:
                        raise OSError('E84のUSB接続が切れました。')
                    buffer.extend(data)
                    while b'\n' in buffer:
                        line, _, rest = buffer.partition(b'\n')
                        buffer = bytearray(rest)
                        self.record(line.decode('utf-8', errors='replace'))
                    if len(buffer) > 8192:
                        self.record(buffer.decode('utf-8', errors='replace'))
                        buffer.clear()
            except (OSError, termios.error) as error:
                with self.lock:
                    self.connected = False
                    self.stage = 'E84のUSB接続を待機'
                    self.link_state = 'unknown'
                    self.link_detail = 'E84のUSB再接続後の連携は未確認です。'
                self.record('[MONITOR] '+str(error))
            finally:
                with self.lock:
                    self.fd = None
                    self.connected = False
                    if fd is not None:
                        try:
                            if original is not None:
                                termios.tcsetattr(fd, termios.TCSANOW, original)
                        except (OSError, termios.error):
                            pass
                        os.close(fd)
            self.stop.wait(2)

    def close(self):
        self.stop.set()
        with self.changed:
            self.changed.notify_all()
        self.worker.join(timeout=3)


class SerialBridge:
    def __init__(self, port, log=None):
        self.port = port
        self.lock = threading.Lock()
        self.log = log or (lambda text: None)
        self.buffer = bytearray()
        self.last_calibration_active = None
        self.stop = threading.Event()
        self.fd = None
        self.original = None
        self.last_connection_error = None
        try:
            self.connect()
        except (OSError, termios.error) as error:
            self.last_connection_error = str(error)
            self.log('[M5 USB] '+str(error))
        self.worker = threading.Thread(target=self.run, daemon=True)
        self.worker.start()

    def connect(self):
        fd = os.open(self.port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        try:
            original = termios.tcgetattr(fd)
            attrs = termios.tcgetattr(fd)
            attrs[0] = attrs[1] = attrs[3] = 0
            attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
            attrs[4] = attrs[5] = termios.B115200
            attrs[6][termios.VMIN] = attrs[6][termios.VTIME] = 0
            termios.tcsetattr(fd, termios.TCSANOW, attrs)
            termios.tcflush(fd, termios.TCIFLUSH)
        except (OSError, termios.error):
            os.close(fd)
            raise
        self.fd, self.original = fd, original
        self.buffer.clear()
        self.last_calibration_active = None
        self.last_connection_error = None
        self.log('[M5 USB] connected: '+self.port)

    def disconnect(self):
        if self.fd is not None:
            try:
                termios.tcsetattr(self.fd, termios.TCSANOW, self.original)
            except (OSError, termios.error):
                pass
            os.close(self.fd)
            self.fd = self.original = None

    def read_lines(self, wait):
        if self.fd is None:
            raise OSError('M5のUSB接続を待機しています。')
        if select.select([self.fd], [], [], wait)[0]:
            chunk = os.read(self.fd, 4096)
            if not chunk:
                raise OSError('M5のUSB接続が切れました。')
            self.buffer.extend(chunk)
        lines = []
        while b'\n' in self.buffer:
            line, _, remainder = self.buffer.partition(b'\n')
            self.buffer = bytearray(remainder)
            if line.startswith(b'[CAL] '):
                reply = json.loads(line[6:])
                active = reply.get('active')
                if type(active) is bool and active != self.last_calibration_active:
                    self.last_calibration_active = active
                    self.log('[M5 MODE] calibration='+('active' if active else 'idle'))
                lines.append(reply)
            else:
                text = line.decode('utf-8', errors='replace').strip('\r')
                if text:
                    self.log('[M5 USB] '+text)
        if len(self.buffer) > 8192:
            self.buffer.clear()
            raise OSError('M5のシリアル応答が大きすぎます。')
        return lines

    def run(self):
        while not self.stop.is_set():
            try:
                with self.lock:
                    if self.fd is None:
                        self.connect()
                    self.read_lines(0)
                self.stop.wait(.05)
            except (OSError, ValueError, termios.error) as error:
                with self.lock:
                    self.disconnect()
                if str(error) != self.last_connection_error:
                    self.log('[M5 USB] '+str(error))
                    self.last_connection_error = str(error)
                self.stop.wait(2)

    def command(self, command):
        with self.lock:
            if self.fd is None:
                self.connect()
            self.read_lines(0) # preserve diagnostic lines, discard older CAL replies
            os.write(self.fd, (command + '\n').encode('ascii'))
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                replies = self.read_lines(.1)
                if replies:
                    return replies[0]
            raise TimeoutError('M5から応答がありません。角度調整対応ファームウェアとUSB接続を確認してください。')

    def close(self):
        try:
            self.command('@cancel')
        except (OSError, TimeoutError):
            pass
        self.stop.set()
        self.worker.join(timeout=1)
        with self.lock:
            self.disconnect()


def command_for(action, body):
    if action in ('begin', 'save', 'cancel'):
        return '@' + action
    if action == 'test':
        if body.get('target') not in ('c', 'e'):
            raise ValueError('通話または終了ボタンを選んでください。')
        return '@test ' + body['target']
    if action == 'stop_test':
        return '@stop'
    if action == 'mirror':
        if body.get('target') != 'e':
            raise ValueError('反転できるのは終了側です。')
        return '@mirror e'
    if action == 'angles':
        target, rest, press = body.get('target'), body.get('rest'), body.get('press')
        if target not in ('c', 'e') or any(type(x) is not int or not 0 <= x <= 180 for x in (rest, press)):
            raise ValueError('角度は0〜180の整数で指定してください。')
        return f'@angles {target} {rest} {press}'
    if action == 'preview':
        target, position, angle = body.get('target'), body.get('position'), body.get('angle')
        if target not in ('c', 'e') or position not in ('r', 'p') or type(angle) is not int or not 0 <= angle <= 180:
            raise ValueError('角度は0〜180の整数で指定してください。')
        return f'@set {target} {position} {angle}'
    if action == 'timing':
        field, value = body.get('field'), body.get('value')
        limits = {'call_delay_ms': ('d', 0, 30000), 'call_hold_ms': ('c', 100, 2000),
                  'end_hold_ms': ('e', 100, 2000), 'return_ms': ('r', 100, 3000)}
        if field not in limits or type(value) is not int:
            raise ValueError('動作時間を正しく指定してください。')
        target, low, high = limits[field]
        if not low <= value <= high:
            raise ValueError('動作時間が指定範囲外です。')
        return f'@time {target} {value}'
    raise ValueError('不明な操作です。')


def handler_for(bridge, monitor=None, diagnostics=None):
    class Handler(BaseHTTPRequestHandler):
        def reply(self, status, body, content_type='application/json; charset=utf-8'):
            raw = json.dumps(body, ensure_ascii=False).encode() if isinstance(body, dict) else body
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            route = urlsplit(self.path)
            if route.path == '/api/diagnostics':
                if diagnostics is None:
                    self.reply(503, {'ok': False, 'error': '通信診断が無効です。'})
                else:
                    self.reply(200, diagnostics.snapshot())
                return
            if route.path == '/api/conversations':
                if monitor is None:
                    self.reply(503, {'ok': False, 'error': 'E84ログ監視が無効です。'})
                    return
                try:
                    query = parse_qs(route.query)
                    self.reply(200, monitor.history.snapshot(query.get('id', [None])[0],
                        int(query.get('after', ['-1'])[0])))
                except ValueError:
                    self.reply(400, {'ok': False, 'error': '不正な履歴位置です。'})
                return
            if route.path == '/api/logs':
                if monitor is None:
                    self.reply(503, {'ok': False, 'error': 'E84ログ監視が無効です。'})
                    return
                try:
                    after = int(parse_qs(route.query).get('after', ['0'])[0])
                    if after < 0:
                        raise ValueError()
                    self.reply(200, monitor.snapshot(after))
                except ValueError:
                    self.reply(400, {'ok': False, 'error': '不正なログ位置です。'})
                return
            if self.path == '/':
                self.reply(200, Path(__file__).with_name('index.html').read_bytes(), 'text/html; charset=utf-8')
            elif self.path == '/api/state':
                try:
                    self.reply(200, bridge.command('@get'))
                except (OSError, TimeoutError, ValueError) as error:
                    self.reply(503, {'ok': False, 'error': str(error)})
            elif self.path == '/diagnostics.js':
                self.reply(200, Path(__file__).with_name('diagnostics.js').read_bytes(), 'text/javascript; charset=utf-8')
            else:
                self.reply(404, {'ok': False, 'error': 'Not found'})

        def do_POST(self):
            allowed = {f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}'}
            if self.headers.get('Origin') not in allowed or self.headers.get('Content-Type') != 'application/json':
                self.reply(403, {'ok': False, 'error': 'この画面から操作してください。'})
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 1024:
                    raise ValueError('不正なリクエストです。')
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, dict) or not self.path.startswith('/api/'):
                    raise ValueError('不正なリクエストです。')
                if self.path == '/api/diagnostics':
                    if diagnostics is None:
                        raise OSError('通信診断が無効です。')
                    self.reply(202, diagnostics.start(body.get('target')))
                    return
                if self.path == '/api/console':
                    if monitor is None:
                        raise OSError('E84ログ監視が無効です。')
                    self.reply(200, monitor.send(body.get('command')))
                    return
                command = command_for(self.path[5:], body)
                self.reply(200, bridge.command(command))
            except DiagnosticBusy as error:
                self.reply(409, {'ok': False, 'error': str(error)})
            except (ValueError, TypeError) as error:
                self.reply(400, {'ok': False, 'error': str(error)})
            except (OSError, TimeoutError) as error:
                self.reply(503, {'ok': False, 'error': str(error)})

        def log_message(self, format, *args):
            pass
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial-port', required=True)
    parser.add_argument('--http-port', type=int, default=8767)
    parser.add_argument('--e84-port', help='E84 UART port (default: auto-detect /dev/cu.usbmodem*)')
    parser.add_argument('--history-file', default=str(Path(__file__).parent / '.runtime' / 'conversations.json'))
    args = parser.parse_args()
    monitor = E84Monitor(args.e84_port, args.history_file)
    bridge = SerialBridge(args.serial_port, log=monitor.record)
    diagnostics = Diagnostics(bridge, monitor)
    def interrupt(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupt)
    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.http_port), handler_for(bridge, monitor, diagnostics))
        print(f'M5角度調整: http://127.0.0.1:{args.http_port}', flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        diagnostics.close()
        monitor.close()
        bridge.close()


if __name__ == '__main__':
    main()
