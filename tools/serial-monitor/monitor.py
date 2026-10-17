#!/usr/bin/env python3
"""Read the board UART and serve a loopback-only, dependency-free dashboard.

Run: python3 tools/serial-monitor/monitor.py [--serial /dev/cu.usbmodem...] [--port 8766]
The monitor never contacts the Door API itself or replays an old log file.

GET /api/state returns epoch-second timestamps (null means unobserved):
  server_now, started_at,
  serial: connected, port, error, last_line_at,
  wifi: state, ip, last_seen_at, channel, rssi, scan_at,
  server: state, checking, last_check_at, last_success_at, error,
          endpoints: {path: {status, checked_at, body, error}},
  clock: state, utc, synced_at, error,
  models: asr:{model,ready}, tts:{model,voice,ready}, llm:{model},
  logs: [{id,timestamp,level,text}], thresholds.

Wi-Fi states: unknown/connecting/connected/disconnected/error/stale.
Server states: unknown/checking/ok/error/stale. Clock states:
unknown/syncing/synced/error/stale. Scan RSSI is a historical startup scan,
not a continuous signal measurement. Old "Last HTTPS ... passed" heartbeats
never advance the last actual HTTPS check or success timestamp.
"""

import argparse
from collections import deque
import copy
import datetime
import errno
import fcntl
import glob
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import mimetypes
import os
from pathlib import Path
import re
import select
import signal
import stat
import subprocess
import sys
import termios
import threading
import time
from urllib.parse import unquote, urlsplit


TELEMETRY_STALE_SECONDS = 35
SERVER_STALE_SECONDS = 150
MAX_LOG_LINES = 400
MAX_LINE_CHARS = 2048
MAX_LINE_BYTES = 8192
ENDPOINTS = ("/health", "/v1/status")
STATIC_DIR = Path(__file__).resolve().parent / "static"
ANSI_ESCAPE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")


def clean_line(line):
    line = ANSI_ESCAPE.sub("", line)
    return "".join(c for c in line if c == "\t" or ord(c) >= 32 and ord(c) != 127)[:MAX_LINE_CHARS]


class LineFramer:
    """Bounded UTF-8 line assembly, including split CRLF and split code points."""

    def __init__(self):
        self.pending = bytearray()
        self.truncated = False

    def feed(self, data):
        lines = []
        for byte in data:
            if byte in (10, 13):
                if self.pending or self.truncated:
                    line = self.pending.decode("utf-8", errors="replace")
                    if self.truncated:
                        line = line[:MAX_LINE_CHARS - 17] + " [line truncated]"
                    lines.append(line)
                self.pending.clear()
                self.truncated = False
            elif len(self.pending) < MAX_LINE_BYTES:
                self.pending.append(byte)
            else:
                self.truncated = True
        return lines


def empty_endpoints():
    return {path: {"status": None, "checked_at": None, "body": None, "error": None}
            for path in ENDPOINTS}


def empty_models():
    return {"asr": {"model": None, "ready": None},
            "tts": {"model": None, "voice": None, "ready": None},
            "llm": {"model": None}}


class MonitorState:
    def __init__(self, now=None):
        self.lock = threading.RLock()
        self.started_at = time.time() if now is None else now
        self.serial = {"connected": False, "port": None, "error": None, "last_line_at": None}
        self.logs = deque(maxlen=MAX_LOG_LINES)
        self.next_log_id = 1
        self._reset_board()

    def _reset_board(self):
        self.wifi = {"state": "unknown", "ip": None, "last_seen_at": None,
                     "channel": None, "rssi": None, "scan_at": None}
        self.server = {"state": "unknown", "checking": False, "last_check_at": None,
                       "last_success_at": None, "error": None, "endpoints": empty_endpoints()}
        self.clock = {"state": "unknown", "utc": None, "synced_at": None, "error": None}
        self.models = empty_models()

    def _log(self, text, now, level="info"):
        self.logs.append({"id": self.next_log_id, "timestamp": now,
                          "level": level, "text": clean_line(text)})
        self.next_log_id += 1

    def serial_connected(self, port, now=None):
        now = time.time() if now is None else now
        with self.lock:
            # A new USB attachment may be a different board or a rebooted board.
            self._reset_board()
            self.serial.update(connected=True, port=port, error=None, last_line_at=None)
            self._log("[MONITOR] シリアル接続: " + port, now, "success")

    def serial_disconnected(self, error, port=None, now=None):
        now = time.time() if now is None else now
        with self.lock:
            changed = self.serial["connected"] or self.serial["error"] != error or self.serial["port"] != port
            self.serial.update(connected=False, port=port, error=clean_line(error))
            self.server["checking"] = False
            if changed:
                self._log("[MONITOR] " + error, now, "warning")

    def _start_check(self, now):
        self.server.update(state="checking", checking=True, last_check_at=now,
                           error=None, endpoints=empty_endpoints())
        self.models = empty_models()

    def _server_error(self, message, now):
        self.server.update(state="error", error=message)
        if self.server["last_check_at"] is None:
            self.server["last_check_at"] = now

    def _finish_check(self, passed, now):
        self.server["checking"] = False
        self.server["last_check_at"] = now
        endpoints = self.server["endpoints"]
        complete = all(endpoints[p]["status"] == 200 and not endpoints[p]["error"]
                       for p in ENDPOINTS)
        if passed and complete:
            self.server.update(state="ok", last_success_at=now, error=None)
        else:
            self.server.update(state="error", error=self.server["error"] or
                               ("今回の応答をすべて確認できませんでした。" if passed else
                                "基板の HTTPS 通信チェックに失敗しました。"))

    def _response(self, path, code, body_text, now):
        endpoint = {"status": code, "checked_at": now, "body": None, "error": None}
        try:
            body = json.loads(body_text, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if not isinstance(body, dict):
                raise ValueError()
            endpoint["body"] = body
        except (ValueError, TypeError, RecursionError):
            endpoint["error"] = "JSON 応答を読み取れませんでした。"
        if code != 200:
            endpoint["error"] = "HTTP " + str(code)
        elif path == "/health" and not endpoint["error"] and endpoint["body"].get("status") != "ok":
            endpoint["error"] = "health の status が ok ではありません。"
        self.server["endpoints"][path] = endpoint
        if endpoint["error"]:
            self._server_error(path + ": " + endpoint["error"], now)
        elif path == "/v1/status":
            body = endpoint["body"]
            models = empty_models()
            for name, fields in (("asr", ("model", "ready")),
                                 ("tts", ("model", "voice", "ready")), ("llm", ("model",))):
                values = body.get(name)
                if isinstance(values, dict):
                    for field in fields:
                        value = values.get(field)
                        if field == "ready" and isinstance(value, bool):
                            models[name][field] = value
                        elif field != "ready" and isinstance(value, str):
                            models[name][field] = clean_line(value)[:200]
            self.models = models

    def accept_line(self, line, now=None):
        now = time.time() if now is None else now
        line = clean_line(line)
        if not line.strip():
            return
        with self.lock:
            self.serial["last_line_at"] = now
            level = "info"
            if re.search(r"failed|error|incomplete|lost|invalid|timed out|deadline|no valid|not enough", line, re.I):
                level = "error"
            elif "[OK]" in line or "checks passed" in line or "Check complete: passed" in line:
                level = "success"
            elif "[WAIT]" in line or "[SETUP]" in line:
                level = "warning"
            self._log(line, now, level)

            if line.startswith("CY8CPROTO-062-4343W Wi-Fi"):
                self._reset_board()
                return
            scan = re.search(r"\[SCAN\] Configured network found: channel (\d+), signal (-?\d+) dBm", line)
            if scan:
                self.wifi.update(channel=int(scan[1]), rssi=int(scan[2]), scan_at=now)
            ip = re.search(r"\[OK\] Wi-Fi connected \+ DHCP OK\. IP: (\d+\.\d+\.\d+\.\d+)", line)
            if ip:
                try:
                    address = str(ipaddress.IPv4Address(ip[1]))
                    if address == "0.0.0.0":
                        raise ValueError()
                    self.wifi.update(state="connected", ip=address, last_seen_at=now)
                except ValueError:
                    self.wifi.update(state="error", ip=None)
            elif "[Wi-Fi] Connecting" in line:
                self.wifi.update(state="connecting", ip=None)
            elif "[Wi-Fi] Connect failed" in line:
                self.wifi.update(state="error", ip=None)
            elif "[Wi-Fi] Connection lost" in line or "[WAIT] Waiting for Wi-Fi" in line:
                self.wifi.update(state="disconnected", ip=None)
                self.server.update(state="unknown", checking=False, error="Wi-Fi 接続を待っています。")
            elif "[Wi-Fi] Reconnected" in line or "[Wi-Fi] IP address changed" in line:
                self.wifi.update(state="connecting", ip=None)
            elif line.startswith("[SETUP]") or line.startswith("[ERROR]"):
                self.wifi.update(state="error", ip=None)
                self.server.update(state="unknown", checking=False, error=line)

            if line.startswith("[TIME] Synchronizing clock"):
                self.clock.update(state="syncing", error=None)
            elif line.startswith("[TIME] UTC "):
                try:
                    value = datetime.datetime.strptime(line[11:], "%Y-%m-%d %H:%M:%S")
                    self.clock.update(state="synced", utc=value.isoformat() + "Z", synced_at=now, error=None)
                except ValueError:
                    self.clock.update(state="error", error="時刻の形式を読み取れませんでした。")
            elif line.startswith("[TIME]") and level == "error":
                self.clock.update(state="error", error=line)

            if line == "[SERVER] Check started.":
                self._start_check(now)
            elif line.startswith("[SERVER] HTTPS GET "):
                if not self.server["checking"]:
                    self._start_check(now)
            elif line.startswith("[SERVER] Last HTTPS health/status check: passed."):
                # An old firmware heartbeat repeats historical success every 10s.
                # It is NOT a new network request and must never refresh health.
                return
            elif line.startswith("[SERVER] HTTPS health and status checks passed."):
                self._finish_check(True, now)
            elif line.startswith("[SERVER] Check complete:"):
                self._finish_check(line.startswith("[SERVER] Check complete: passed."), now)
            elif line.startswith("[SERVER] Check incomplete."):
                self._finish_check(False, now)
            else:
                response = re.match(r"\[SERVER\] (/health|/v1/status) HTTP (\d{3}); body \(\d+ bytes\): (.*)", line)
                if response:
                    self._response(response[1], int(response[2]), response[3], now)
                elif line.startswith("[SERVER]") and level == "error":
                    self._server_error(line, now)

    def snapshot(self, now=None):
        now = time.time() if now is None else now
        with self.lock:
            result = copy.deepcopy({"server_now": now, "started_at": self.started_at,
                                    "serial": self.serial, "wifi": self.wifi, "server": self.server,
                                    "clock": self.clock, "models": self.models, "logs": list(self.logs),
                                    "thresholds": {"telemetry_stale_seconds": TELEMETRY_STALE_SECONDS,
                                                   "server_stale_seconds": SERVER_STALE_SECONDS}})
        serial = result["serial"]
        last_line = serial["last_line_at"]
        telemetry_stale = last_line is None or now - last_line > TELEMETRY_STALE_SECONDS
        if not serial["connected"]:
            result["wifi"]["state"] = "unknown"
            result["server"]["state"] = "unknown"
            result["server"]["checking"] = False
            result["clock"]["state"] = "unknown"
        elif telemetry_stale:
            for name in ("wifi", "server", "clock"):
                if result[name]["state"] != "unknown":
                    result[name]["state"] = "stale"
            result["server"]["checking"] = False
        else:
            check_at = result["server"]["last_check_at"]
            if check_at is not None and now - check_at > SERVER_STALE_SECONDS:
                result["server"]["state"] = "stale"
                result["server"]["checking"] = False
        return result


class SerialBusyError(Exception):
    pass


class SerialConnection:
    def __init__(self, port):
        self.port = port
        self.fd = None
        self.original = None
        self.exclusive = False

    def open(self):
        if not stat.S_ISCHR(os.stat(self.port).st_mode):
            raise ValueError("シリアルポートにはデバイスファイルを指定してください。")
        # TIOCEXCL blocks subsequent opens, but not an existing screen process.
        # macOS ships lsof, which lets us avoid stealing its serial data.
        lsof = Path("/usr/sbin/lsof")
        if sys.platform == "darwin" and lsof.exists():
            try:
                result = subprocess.run([str(lsof), "-t", "--", self.port],
                                        capture_output=True, timeout=3, check=False)
                if result.stdout.strip():
                    raise SerialBusyError("別のアプリがシリアルポートを使用中です。screen 等を終了してください。")
            except subprocess.TimeoutExpired:
                raise SerialBusyError("シリアルポートの使用状況を確認できませんでした。再試行します。") from None
        self.fd = os.open(self.port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if hasattr(termios, "TIOCEXCL"):
                fcntl.ioctl(self.fd, termios.TIOCEXCL)
                self.exclusive = True
            self.original = termios.tcgetattr(self.fd)
            attrs = copy.deepcopy(self.original)
            attrs[0] = 0
            attrs[1] = 0
            attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
            attrs[3] = 0
            attrs[4] = termios.B115200
            attrs[5] = termios.B115200
            attrs[6][termios.VMIN] = 0
            attrs[6][termios.VTIME] = 0
            termios.tcsetattr(self.fd, termios.TCSANOW, attrs)
            # Buffered pre-attachment bytes must not look like live telemetry.
            termios.tcflush(self.fd, termios.TCIFLUSH)
        except BaseException:
            self.close()
            raise
        return self

    def close(self):
        if self.fd is None:
            return
        try:
            if self.original is not None:
                try:
                    termios.tcsetattr(self.fd, termios.TCSANOW, self.original)
                except (OSError, termios.error):
                    pass  # A physically detached USB device cannot be restored.
            if self.exclusive and hasattr(termios, "TIOCNXCL"):
                try:
                    fcntl.ioctl(self.fd, termios.TIOCNXCL)
                except OSError:
                    pass
        finally:
            os.close(self.fd)
            self.fd = None


def serial_error(error):
    if isinstance(error, (SerialBusyError, ValueError)):
        return str(error)
    if isinstance(error, PermissionError):
        return "シリアルポートへのアクセスが許可されていません。"
    if getattr(error, "errno", None) in (errno.EBUSY, errno.EAGAIN, errno.EWOULDBLOCK):
        return "シリアルポートが使用中です。別のモニターを終了してください。"
    return "USB 接続が切れたか、シリアルポートを開けませんでした。再接続を待っています。"


def serial_worker(state, stop_event, explicit_port=None):
    while not stop_event.is_set():
        ports = [explicit_port] if explicit_port else sorted(glob.glob("/dev/cu.usbmodem*"))
        if not ports:
            state.serial_disconnected("基板の USB 接続を待っています。")
            stop_event.wait(1)
            continue
        if len(ports) != 1:
            state.serial_disconnected("基板が複数あります。--serial でポートを指定してください。")
            stop_event.wait(1)
            continue
        port = ports[0]
        connection = SerialConnection(port)
        try:
            connection.open()
            state.serial_connected(port)
            framer = LineFramer()
            while not stop_event.is_set():
                ready, _, _ = select.select([connection.fd], [], [], 0.5)
                if not ready:
                    if not os.path.exists(port):
                        raise OSError(errno.ENODEV, "USB detached")
                    continue
                try:
                    data = os.read(connection.fd, 4096)
                except BlockingIOError:
                    continue
                if not data:
                    raise OSError(errno.ENODEV, "USB detached")
                for line in framer.feed(data):
                    state.accept_line(line)
        except (OSError, ValueError, SerialBusyError, termios.error) as error:
            state.serial_disconnected(serial_error(error), port)
        finally:
            connection.close()
        stop_event.wait(1)


def make_handler(state, port, static_dir=STATIC_DIR):
    allowed_hosts = {"127.0.0.1:" + str(port), "localhost:" + str(port)}
    allowed_origins = {"http://" + host for host in allowed_hosts}
    static_dir = Path(static_dir).resolve()

    class Handler(BaseHTTPRequestHandler):
        server_version = "DoorMonitor"
        sys_version = ""

        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def log_message(self, *_args):
            pass

        def _send(self, code, body, content_type="application/json; charset=utf-8", head=False):
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; "
                             "img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
            self.end_headers()
            if not head:
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        def _error(self, code, message, head=False):
            self._send(code, json.dumps({"error": message}, ensure_ascii=False).encode(), head=head)

        def _get(self, head=False):
            if self.headers.get("Host", "").lower() not in allowed_hosts:
                self._error(403, "Local access only", head)
                return
            origin = self.headers.get("Origin")
            if origin is not None and origin.lower() not in allowed_origins:
                self._error(403, "Local access only", head)
                return
            path = unquote(urlsplit(self.path).path)
            if path == "/api/state":
                self._send(200, json.dumps(state.snapshot(), ensure_ascii=False, allow_nan=False).encode(), head=head)
                return
            if path == "/":
                path = "/index.html"
            candidate = (static_dir / path.lstrip("/")).resolve()
            allowed_suffixes = {".html", ".js", ".css", ".svg", ".png", ".ico", ".webp"}
            try:
                candidate.relative_to(static_dir)
                if candidate.suffix not in allowed_suffixes or not candidate.is_file() or candidate.stat().st_size > 2_000_000:
                    raise ValueError()
                body = candidate.read_bytes()
            except (ValueError, OSError):
                self._error(404, "Not found", head)
                return
            mime = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
            self._send(200, body, mime + ("; charset=utf-8" if candidate.suffix in {".html", ".js", ".css", ".svg"} else ""), head)

        def do_GET(self):
            self._get()

        def do_HEAD(self):
            self._get(head=True)

        def do_POST(self):
            self._error(405, "Read-only monitor")

    return Handler


def main(argv=None):
    parser = argparse.ArgumentParser(description="CY8CPROTO Wi-Fi / Door API ブラウザ監視")
    parser.add_argument("--serial", help="シリアルポート。省略時は /dev/cu.usbmodem* を自動検出")
    parser.add_argument("--port", type=int, default=8766, help="ローカル HTTP ポート (default: 8766)")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("--port は 1..65535 を指定してください。")
    state = MonitorState()
    stop_event = threading.Event()
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(state, args.port))
    except OSError:
        print("監視 UI を起動できません。ポートが使用中なら --port 8767 などを指定してください。", file=sys.stderr)
        return 2
    server.daemon_threads = True
    worker = threading.Thread(target=serial_worker, args=(state, stop_event, args.serial), daemon=True)
    worker.start()
    print("監視 UI: http://127.0.0.1:" + str(args.port), flush=True)
    print("USB シリアルを読み取ります。終了は Ctrl+C。", flush=True)

    def stop_on_signal(_signal, _frame):
        raise KeyboardInterrupt()

    previous = signal.signal(signal.SIGTERM, stop_on_signal)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()
        worker.join(timeout=5)
        server.server_close()
        signal.signal(signal.SIGTERM, previous)
        print("監視を終了しました。", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
