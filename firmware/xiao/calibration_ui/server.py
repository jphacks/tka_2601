#!/usr/bin/env python3
"""Local bench UI for checking and tuning the XIAO over USB (Python standard library only)."""
import argparse
from collections import deque
from datetime import datetime
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
from suites import Suites, SuiteBusy


# Lines answering one request; they are returned to the caller, not kept in the log.
REPLY_CHANNELS = ('[CAL]', '[DIAG] mic')
JS = 'text/javascript; charset=utf-8'
STATIC_FILES = {'/': ('index.html', 'text/html; charset=utf-8'),
                '/app.js': ('app.js', JS),
                '/logic.js': ('logic.js', JS),
                '/scene/monban_scene.js': ('scene/monban_scene.js', JS),
                '/scene/monban_meshes.js': ('scene/monban_meshes.js', JS),
                '/vendor/antd-reset.css': ('vendor/antd-reset.css', 'text/css; charset=utf-8'),
                **{f'/vendor/{name}': (f'vendor/{name}', JS) for name in
                   ('react.production.min.js', 'react-dom.production.min.js', 'dayjs.min.js', 'antd.min.js', 'three.min.js')}}
# The bench firmware rings its scripted microphone on these signals; nothing else accepts them.
SIMULATED_SOUNDS = {'chime': signal.SIGUSR1, 'other': signal.SIGUSR2}


class SerialLink:
    """One persistent USB reader. Web clients only read its bounded RAM log."""
    def __init__(self, port, history_path=None):
        self.port = port
        self.fd = None
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.command_lock = threading.Lock() # one reply is paired with one request
        self.command_timeout = 3
        self.stop = threading.Event()
        self.lines = deque(maxlen=500)
        self.sequence = 0
        self.epoch = uuid.uuid4().hex
        self.connected = False
        self.stage = 'XIAOを接続しています'
        self.voice_active = False
        self.recovery_required = False
        self.calibration_active = None
        self.replies = dict.fromkeys(REPLY_CHANNELS)
        self.reply_sequence = dict.fromkeys(REPLY_CHANNELS, 0)
        self.last_connection_error = None
        self.state_due = 0 # when to ask again, until the board has told its state since connecting
        self.last_uptime = None
        self.history = ConversationHistory(history_path)
        self.worker = threading.Thread(target=self.run, daemon=True)
        self.worker.start()

    def append_line(self, text):
        self.sequence += 1
        self.lines.append({'id': self.sequence, 'time': datetime.now(ZoneInfo('Asia/Tokyo')).strftime('%H:%M:%S'), 'text': text})

    def set_calibration_active(self, active):
        if active != self.calibration_active:
            self.calibration_active = active
            self.append_line('[MODE] calibration='+('active' if active else 'idle'))

    def record(self, text):
        text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text).strip('\r\n')
        if not text:
            return
        with self.lock:
            state = re.match(r'\[STATE\] busy=(\d) recovery=(\d) uptime_ms=(\d+)', text)
            if state:
                self.apply_board_state(bool(int(state[1])), bool(int(state[2])), int(state[3]))
            self.history.record(text)
            if any(marker in text for marker in ('Preparing streaming call', 'Listening:', 'Response ')):
                self.voice_active = True
            elif any(marker in text for marker in ('[BOOT] Network task running', 'Call ended;', 'Call stopped;')):
                self.voice_active = False
                self.recovery_required = False
            if 'Playback/call state uncertain' in text:
                self.recovery_required = True
                # The firmware states that network resources are released before
                # diagnostics may run; without that statement keep the busy guard.
                self.voice_active = 'Diagnostics available.' not in text
            self.append_line(text)
            if text.startswith('[STREAM] USB angle calibration;'):
                self.set_calibration_active(True)
            elif text.startswith(('[STREAM] Servo angles saved', '[STREAM] Calibration cancelled', '[STREAM] Calibration timed out')):
                self.set_calibration_active(False)
            if text.startswith('[SETUP] '):
                self.stage = text[len('[SETUP] '):]
            for marker, stage in [
                ('[DETECTED]', 'チャイムを検知しました'),
                ('[BOOT] Network task running', 'XIAO起動中・ネットワーク接続待ち'),
                ('[OK] Wi-Fi connected', 'チャイム待機中'),
                ('Authenticated HTTPS status check passed', 'チャイム待機中（Wi-Fi・サーバー接続OK）'),
                ('Preparing streaming call', '通話を準備中'),
                ('Waiting for one call-button', '設定した時間を待ち、通話ボタンを1回押して戻します'),
                ('CALL waiting', '通話ボタンを押す前の待機中'),
                ('CALL press once:', '通話ボタンを1回押しています'),
                ('CALL returning', '通話ボタンを待機位置へ戻しています'),
                ('CALL released;', '通話ボタンの復帰完了'),
                ('Server ready:', 'サーバー接続完了'),
                ('Call button operation complete', '通話ボタン操作完了・agentに接続中'),
                ('Response 0:', 'スピーカーで挨拶を再生中'),
                ('Response ', 'スピーカーで返答を再生中'),
                ('Output ended:', 'スピーカーの再生完了を待機'),
                ('Playback complete:', 'スピーカーの再生完了'),
                ('Listening:', '聞き取り中：XIAOのマイクに話してください'),
                ('Input streaming:', 'XIAOマイクの音声を送信中'),
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

    def apply_board_state(self, busy, recovery, uptime):
        # USB drops during a reset, so its boot lines can be missed: what the board says now wins.
        restarted = self.last_uptime is not None and uptime < self.last_uptime
        self.last_uptime = uptime
        self.state_due = 0
        self.voice_active = busy and not recovery
        self.recovery_required = recovery
        if restarted:
            self.record('[MONITOR] [BOOT] Network task running: the board restarted while USB was away.')

    def record_reply(self, channel, raw):
        """Deliver one JSON reply to the waiting request; it is not a log line."""
        try:
            reply = json.loads(raw)
            if not isinstance(reply, dict):
                raise ValueError()
        except ValueError:
            self.record('[MONITOR] 不正な'+channel+'応答を無視しました。')
            return
        with self.lock:
            if type(reply.get('active')) is bool:
                self.set_calibration_active(reply['active'])
            self.replies[channel] = reply
            self.reply_sequence[channel] += 1
            self.changed.notify_all()

    def snapshot(self, after=0):
        with self.lock:
            if after > self.sequence:
                after = 0
            return {'ok': True, 'connected': self.connected, 'port': self.port,
                    'voice_active': self.voice_active, 'recovery_required': self.recovery_required,
                    'calibration_active': self.calibration_active,
                    'epoch': self.epoch, 'stage': self.stage, 'next': self.sequence,
                    'lines': [line.copy() for line in self.lines if line['id'] > after]}

    def send(self, command):
        if command not in ('s', 'c', 'e', 'x', 'q', 'u', 'n', 'a', 'w', 't', 'l'):
            raise ValueError('使用できないXIAOコマンドです。')
        with self.lock:
            if self.fd is None:
                raise OSError('XIAOがUSB接続されていません。')
            os.write(self.fd, (command+'\n').encode('ascii'))
        self.record(f'[WEB] {command}: '+{'s': '状態確認', 'c': 'テスト通話を開始', 'e': 'チャイム登録を開始', 'x': 'チャイム登録・サーボテストを中止', 'q': '通話終了要求',
            'u': 'XIAO USB応答確認', 'n': 'XIAO Wi-Fi確認', 'a': 'API HTTPS確認', 'w': 'API WebSocket確認',
            't': 'スピーカーのトーン確認', 'l': 'マイク→スピーカーのループバック確認'}[command])
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
                    raise OSError('XIAOのUSB接続が切れました。')
                if any('[BOOT] Network task running' in line['text'] for line in lines):
                    raise OSError('診断中にXIAOが再起動しました。起動後に再確認してください。')
                remaining = deadline-time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('XIAOの診断コマンドに応答がありません。USB接続と対応ファームウェアを確認してください。')
                self.changed.wait(min(remaining, .5))

    def request(self, channel, command):
        with self.command_lock, self.changed:
            if self.fd is None:
                raise OSError('XIAOのUSB接続を待機しています。')
            after = self.reply_sequence[channel] # older replies cannot answer this request
            os.write(self.fd, (command+'\n').encode('ascii'))
            deadline = time.monotonic()+self.command_timeout
            while self.reply_sequence[channel] == after:
                if not self.connected or self.stop.is_set():
                    raise OSError('XIAOのUSB接続が切れました。')
                remaining = deadline-time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('XIAOから応答がありません。対応ファームウェアとUSB接続を確認してください。')
                self.changed.wait(min(remaining, .5))
            return self.replies[channel]

    def command(self, command):
        return self.request('[CAL]', command)

    def mic(self):
        # Polled about twice a second, so neither the request nor the reply enters the log.
        return self.request('[DIAG] mic', 'm')

    def format_storage(self):
        # Offered only while the store is unusable, so the page never erases a registered chime.
        if self.mic().get('storage') is not False:
            raise ValueError('保存領域は初期化済みです。')
        with self.lock:
            if self.fd is None:
                raise OSError('XIAOがUSB接続されていません。')
            os.write(self.fd, b'FORMAT_AUDIO_STORAGE\n')
        self.record('[WEB] 保存領域を初期化')
        return {'ok': True}

    def run(self):
        while not self.stop.is_set():
            fd = None
            original = None
            try:
                fd = os.open(self.port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
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
                    self.connected = True
                    self.last_connection_error = None
                    self.stage = 'XIAO接続済み・チャイムを待機'
                self.record('[MONITOR] XIAO USB connected: '+self.port)
                self.send('s')
                self.state_due = time.monotonic()+2
                buffer = bytearray()
                while not self.stop.is_set():
                    if not select.select([fd], [], [], .2)[0]:
                        # The board may still have been starting when it was first asked.
                        if self.state_due and time.monotonic() > self.state_due:
                            self.state_due = time.monotonic()+2
                            os.write(fd, b's\n')
                        continue
                    data = os.read(fd, 8192)
                    if not data:
                        raise OSError('XIAOのUSB接続が切れました。')
                    buffer.extend(data)
                    while b'\n' in buffer:
                        line, _, rest = buffer.partition(b'\n')
                        buffer = bytearray(rest)
                        text = line.decode('utf-8', errors='replace')
                        channel = next((name for name in REPLY_CHANNELS if text.startswith(name+' ')), None)
                        if channel:
                            self.record_reply(channel, text[len(channel)+1:])
                        else:
                            self.record(text)
                    if len(buffer) > 8192:
                        self.record(buffer.decode('utf-8', errors='replace'))
                        buffer.clear()
            except (OSError, termios.error) as error:
                with self.lock:
                    self.connected = False
                    self.calibration_active = None
                    self.stage = 'XIAOのUSB接続を待機'
                    report = str(error) != self.last_connection_error
                    self.last_connection_error = str(error)
                if report: # a missing port is retried every 2 s without flooding the log
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
                    self.changed.notify_all()
            self.stop.wait(2)

    def close(self):
        try:
            self.command('@cancel')
        except (OSError, TimeoutError):
            pass
        self.stop.set()
        with self.changed:
            self.changed.notify_all()
        self.worker.join(timeout=3)


def command_for(action, body):
    if action in ('begin', 'save', 'cancel'):
        return '@' + action
    if action == 'test':
        if body.get('target') not in ('c', 'e', 'u'):
            raise ValueError('通話・終了・解錠ボタンのいずれかを選んでください。')
        return '@test ' + body['target']
    if action == 'stop_test':
        return '@stop'
    if action == 'mirror':
        if body.get('target') != 'e':
            raise ValueError('反転できるのは終了側です。')
        return '@mirror e'
    if action == 'angles':
        target, rest, press = body.get('target'), body.get('rest'), body.get('press')
        if target not in ('c', 'e', 'u') or any(type(x) is not int or not 0 <= x <= 180 for x in (rest, press)):
            raise ValueError('角度は0〜180の整数で指定してください。')
        return f'@angles {target} {rest} {press}'
    if action == 'preview':
        target, position, angle = body.get('target'), body.get('position'), body.get('angle')
        if target not in ('c', 'e', 'u') or position not in ('r', 'p') or type(angle) is not int or not 0 <= angle <= 180:
            raise ValueError('角度は0〜180の整数で指定してください。')
        return f'@set {target} {position} {angle}'
    if action == 'timing':
        field, value = body.get('field'), body.get('value')
        limits = {'call_delay_ms': ('d', 0, 30000), 'call_hold_ms': ('c', 100, 2000),
                  'end_hold_ms': ('e', 100, 2000), 'unlock_hold_ms': ('u', 100, 2000),
                  'return_ms': ('r', 100, 3000)}
        if field not in limits or type(value) is not int:
            raise ValueError('動作時間を正しく指定してください。')
        target, low, high = limits[field]
        if not low <= value <= high:
            raise ValueError('動作時間が指定範囲外です。')
        return f'@time {target} {value}'
    if action == 'tune':
        field, value = body.get('field'), body.get('value')
        limits = {'volume': (0, 100), 'gate': (30, 32767), 'margin': (50, 200)}
        if field not in limits or type(value) is not int:
            raise ValueError('調整値を正しく指定してください。')
        low, high = limits[field]
        if not low <= value <= high:
            raise ValueError('調整値が指定範囲外です。')
        return f'@tune {field} {value}'
    raise ValueError('不明な操作です。')


class PageServer(ThreadingHTTPServer):
    # The page opens about ten files at once on top of its pollers; the default queue of 5 resets some.
    request_queue_size = 128


def handler_for(link, diagnostics=None, suites=None, target='xiao', simulator_pid=None):
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
            if route.path == '/api/target':
                self.reply(200, {'ok': True, 'target': target, 'simulated_sound': simulator_pid is not None})
                return
            if route.path == '/api/tests':
                if suites is None:
                    self.reply(503, {'ok': False, 'error': 'テストの実行が無効です。'})
                else:
                    self.reply(200, suites.snapshot())
                return
            if route.path == '/api/diagnostics':
                if diagnostics is None:
                    self.reply(503, {'ok': False, 'error': '通信診断が無効です。'})
                else:
                    self.reply(200, diagnostics.snapshot())
                return
            if route.path == '/api/conversations':
                try:
                    query = parse_qs(route.query)
                    self.reply(200, link.history.snapshot(query.get('id', [None])[0],
                        int(query.get('after', ['-1'])[0])))
                except ValueError:
                    self.reply(400, {'ok': False, 'error': '不正な履歴位置です。'})
                return
            if route.path == '/api/logs':
                try:
                    after = int(parse_qs(route.query).get('after', ['0'])[0])
                    if after < 0:
                        raise ValueError()
                    self.reply(200, link.snapshot(after))
                except ValueError:
                    self.reply(400, {'ok': False, 'error': '不正なログ位置です。'})
                return
            if route.path == '/api/mic':
                try:
                    self.reply(200, {'ok': True} | link.mic())
                except (OSError, TimeoutError) as error:
                    self.reply(503, {'ok': False, 'error': str(error)})
                return
            if route.path == '/api/tune':
                try:
                    self.reply(200, link.command('@tune get'))
                except (OSError, TimeoutError) as error:
                    self.reply(503, {'ok': False, 'error': str(error)})
                return
            if self.path in STATIC_FILES:
                name, content_type = STATIC_FILES[self.path]
                self.reply(200, (Path(__file__).parent / name).read_bytes(), content_type)
            elif self.path == '/api/state':
                try:
                    self.reply(200, link.command('@get'))
                except (OSError, TimeoutError, ValueError) as error:
                    self.reply(503, {'ok': False, 'error': str(error)})
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
                if self.path == '/api/tests':
                    if suites is None:
                        raise OSError('テストの実行が無効です。')
                    self.reply(200, suites.stop() if body.get('stop') is True else suites.start(body.get('suite')))
                    return
                if self.path == '/api/simulate':
                    sound = SIMULATED_SOUNDS.get(body.get('sound'))
                    if simulator_pid is None or sound is None:
                        raise ValueError('この接続先では音を鳴らせません。')
                    os.kill(simulator_pid, sound)
                    self.reply(200, {'ok': True})
                    return
                if self.path == '/api/console':
                    self.reply(200, link.send(body.get('command')))
                    return
                if self.path == '/api/format':
                    if body.get('confirm') != 'FORMAT_AUDIO_STORAGE':
                        raise ValueError('確認の指定がありません。')
                    self.reply(200, link.format_storage())
                    return
                command = command_for(self.path[5:], body)
                self.reply(200, link.command(command))
            except (DiagnosticBusy, SuiteBusy) as error:
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
    parser.add_argument('--history-file', default=str(Path(__file__).parent / '.runtime' / 'conversations.json'))
    parser.add_argument('--target', choices=('xiao', 'bench', 'qemu'), default='xiao')
    parser.add_argument('--simulator-pid', type=int, help='bench firmware process that rings its scripted microphone')
    args = parser.parse_args()
    link = SerialLink(args.serial_port, args.history_file)
    diagnostics = Diagnostics(link)
    suites = Suites()
    def interrupt(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupt)
    try:
        server = PageServer(('127.0.0.1', args.http_port), handler_for(link, diagnostics, suites, args.target, args.simulator_pid))
        print(f'MONBAN 調整: http://127.0.0.1:{args.http_port}', flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        suites.close()
        diagnostics.close()
        link.close()


if __name__ == '__main__':
    main()
