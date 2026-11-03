"""Runs the firmware's own check commands for the bench page's test screen."""
from collections import deque
import os
from pathlib import Path
import signal
import subprocess
import threading
import time

RUN_SH = Path(__file__).parents[1] / 'run.sh'
SUITES = {
    'host': ('各部のテスト', ['bash', str(RUN_SH), 'test']),
    'relay': ('本物の中継サーバーと会話', ['bash', str(RUN_SH), 'e2e']),
    'build': ('ESP32-S3 用のビルド', ['bash', str(RUN_SH), 'build']),
    'qemu': ('QEMU で実機用バイナリを起動', ['bash', str(RUN_SH), 'qemu']),
}


class SuiteBusy(Exception):
    pass


class Suites:
    """One suite at a time; the output stays in RAM and each run replaces the last."""
    def __init__(self, suites=SUITES):
        self.suites = suites
        self.lock = threading.Lock()
        self.results = {key: {'name': name, 'state': 'idle', 'seconds': None, 'finished_at': None, 'lines': deque(maxlen=2000)}
                        for key, (name, _) in suites.items()}
        self.queue = deque()
        self.running = None
        self.process = None
        self.stopping = False
        self.closed = False

    def snapshot(self):
        with self.lock:
            return {'ok': True, 'running': self.running, 'queued': list(self.queue),
                    'suites': {key: {**value, 'lines': list(value['lines'])} for key, value in self.results.items()}}

    def start(self, target):
        if target != 'all' and target not in self.suites:
            raise ValueError('不明なテストです。')
        with self.lock:
            if self.closed or self.running or self.queue:
                raise SuiteBusy('別のテストが実行中です。')
            self.stopping = False
            self.queue.extend(self.suites if target == 'all' else [target])
            for key in self.queue:
                self.results[key].update(state='waiting', seconds=None, finished_at=None)
                self.results[key]['lines'].clear()
            threading.Thread(target=self._worker, daemon=True).start()
        return self.snapshot()

    def stop(self):
        with self.lock:
            for key in self.queue:
                self.results[key]['state'] = 'idle'
            self.queue.clear()
            self.stopping = True
            process = self.process
        if process:
            self._kill(process)
        return self.snapshot()

    @staticmethod
    def _kill(process):
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    def _worker(self):
        while True:
            with self.lock:
                if not self.queue:
                    self.running = None
                    return
                key = self.running = self.queue.popleft()
                result = self.results[key]
                result['state'] = 'running'
            started = time.monotonic()
            try:
                # Its own process group, so stopping also stops what the script started.
                process = subprocess.Popen(self.suites[key][1], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                           stdin=subprocess.DEVNULL, text=True, errors='replace', start_new_session=True)
            except OSError as error:
                with self.lock:
                    result['lines'].append(str(error))
                    result.update(state='failed', seconds=0, finished_at=time.time())
                continue
            with self.lock:
                self.process = process
                if self.stopping: # stop arrived while this one was starting
                    self._kill(process)
            for line in process.stdout:
                with self.lock:
                    result['lines'].append(line.rstrip('\r\n'))
            code = process.wait()
            with self.lock:
                self.process = None
                result.update(state='ok' if code == 0 else 'stopped' if code in (-signal.SIGTERM, 128 + signal.SIGTERM) else 'failed',
                              seconds=round(time.monotonic() - started, 1), finished_at=time.time())

    def close(self):
        with self.lock:
            self.closed = True
        self.stop()
