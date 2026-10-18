"""Bounded local text history reconstructed from real E84 voice events."""
from datetime import datetime
import json
import os
from pathlib import Path
import re
import threading
import uuid
from zoneinfo import ZoneInfo


class ConversationHistory:
    def __init__(self, path=None):
        self.path = Path(path) if path else None
        self.lock = threading.RLock()
        self.sessions = []
        self.current = None
        self.turn = 0
        self.revision = 0
        self.error = None
        if self.path and self.path.exists():
            try:
                data = json.loads(self.path.read_text())
                if not isinstance(data, list):
                    raise ValueError('履歴の形式が不正です。')
                for item in data[-20:]:
                    if not isinstance(item, dict) or not isinstance(item.get('messages'), list) or any(
                        not isinstance(item.get(key), str) for key in ('id', 'started', 'status')
                    ) or any(not isinstance(message, dict) or message.get('speaker') not in ('visitor', 'ai') or any(
                        not isinstance(message.get(key), str) for key in ('text', 'time')
                    ) for message in item['messages']):
                        raise ValueError('履歴の形式が不正です。')
                    item.setdefault('ended', None)
                    item.setdefault('reason', None)
                    item['messages'] = item['messages'][-200:]
                    if item.get('status') == 'active':
                        item['status'] = 'monitor_restarted'
                    self.sessions.append(item)
                self.revision = 1
            except (OSError, ValueError) as error:
                self.error = str(error) # preserve the original file on a read failure

    def _new(self, timestamp):
        self.current = {'id': uuid.uuid4().hex, 'started': timestamp, 'ended': None,
                        'status': 'active', 'reason': None, 'messages': []}
        self.sessions.append(self.current)
        self.sessions = self.sessions[-20:]
        self.turn = 0

    def _save(self):
        self.revision += 1
        if self.path is None or self.error:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            temporary = self.path.with_suffix('.tmp')
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, 'w') as handle:
                json.dump(self.sessions, handle, ensure_ascii=False)
            os.replace(temporary, self.path)
        except OSError as error:
            self.error = str(error)

    def record(self, text, timestamp=None):
        timestamp = timestamp or datetime.now(ZoneInfo('Asia/Tokyo')).isoformat(timespec='seconds')
        with self.lock:
            changed = False
            if '[VOICE] Preparing streaming call.' in text:
                if self.current and self.current['status'] == 'active':
                    self.current['status'] = 'interrupted'
                    self.current['ended'] = timestamp
                self._new(timestamp)
                changed = True
            turn = re.search(r'\[VOICE\] Listening: turn (\d+)', text)
            if turn:
                self.turn = int(turn[1])
            transcript = re.search(r'\[VOICE\] Transcript (visitor|ai): (.*)$', text)
            if transcript:
                try:
                    value = json.loads(transcript[2])
                except (ValueError, TypeError):
                    value = None
                if isinstance(value, str) and value.strip():
                    if self.current is None or self.current['status'] != 'active':
                        self._new(timestamp)
                    self.current['messages'].append({'speaker': transcript[1], 'text': value[:4096],
                                                     'time': timestamp, 'turn': self.turn})
                    self.current['messages'] = self.current['messages'][-200:]
                    changed = True
            if self.current is not None:
                if '[BOOT] Network task running' in text and self.current['status'] == 'active':
                    self.current['status'] = 'device_restarted'
                    self.current['ended'] = timestamp
                    changed = True
                reason = re.search(r'\[VOICE\] Server error code: ([a-z_]+)\.', text)
                if reason:
                    self.current['reason'] = reason[1]
                    changed = True
                if 'Capture aborted:' in text:
                    self.current['reason'] = 'capture_aborted'
                    changed = True
                for marker, status in [('Call ended;', 'ended'), ('Call stopped;', 'stopped'),
                                       ('Playback/call state uncertain', 'needs_attention')]:
                    if marker in text and '[VOICE]' in text:
                        self.current['status'] = status
                        self.current['ended'] = timestamp
                        changed = True
                        break
            if changed:
                self._save()

    def snapshot(self, session_id=None, after=-1):
        with self.lock:
            selected = next((x for x in self.sessions if x['id'] == session_id), None) if session_id else (
                self.sessions[-1] if self.sessions else None)
            summaries = [{key: item[key] for key in ('id', 'started', 'ended', 'status', 'reason')}
                         | {'count': len(item['messages'])} for item in reversed(self.sessions)]
            return {'ok': True, 'revision': self.revision, 'changed': after != self.revision,
                    'sessions': summaries, 'session': json.loads(json.dumps(selected)) if after != self.revision else None,
                    'error': self.error}
