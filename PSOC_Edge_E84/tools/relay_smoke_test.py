#!/usr/bin/env python3
"""One real /api/relay v1 turn using a PCM WAV and local API settings.

No resident key is supplied: this is an unpaired diagnostic session. Requires
websocket-client and certifi. Does not operate either board or save audio.
"""
import argparse
import ast
import json
from pathlib import Path
import re
import time
import uuid
import wave

import certifi
import websocket


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('wav', type=Path)
    parser.add_argument('--seconds', type=float, default=60)
    args = parser.parse_args()
    with wave.open(str(args.wav), 'rb') as recording:
        if (recording.getframerate(), recording.getsampwidth(), recording.getnchannels()) != (16000, 2, 1):
            parser.error('WAV must be 16kHz / PCM16LE / mono')
        pcm = recording.readframes(recording.getnframes())
    if not pcm or not any(pcm) or len(pcm) > 30*32000:
        parser.error('WAV must contain nonzero audio and be at most 30 seconds')
    settings = (Path(__file__).parents[1]/'source/api_config.h').read_text()
    def setting(name):
        match = re.search(r'^#define '+name+r' (".*")$', settings, re.M)
        if not match:
            parser.error('Run configure_api.py first')
        return ast.literal_eval(match[1])
    ws = websocket.create_connection('wss://'+setting('DOOR_API_HOST')+'/api/relay',
        header=['Authorization: Bearer '+setting('DOOR_API_KEY')],
        sslopt={'ca_certs': certifi.where()}, timeout=15)
    began = time.monotonic()
    ready = False
    speaking = visitor_sent = replied = visitor_transcribed = False
    next_tick = began
    first_listen = None
    offset = response_frames = 0
    try:
        ws.send(json.dumps({'type': 'start', 'visit_id': str(uuid.uuid4()),
            'mode': 'omakase', 'device_key': 'e84-diagnostic-unpaired'}))
        ws.settimeout(.008)
        while time.monotonic()-began < args.seconds:
            now = time.monotonic()
            if ready and now >= next_tick:
                next_tick = max(next_tick+.02, now-.02)
                if not speaking:
                    if first_listen is not None and not visitor_sent and now-first_listen > 1:
                        chunk = pcm[offset:offset+640]
                        offset += len(chunk)
                        if offset == len(pcm):
                            visitor_sent = True
                            print('Visitor WAV sent', flush=True)
                        ws.send_binary(chunk.ljust(640, b'\0'))
                    else:
                        ws.send_binary(bytes(640))
            try:
                message = ws.recv()
            except websocket.WebSocketTimeoutException:
                continue
            if not message:
                break
            if isinstance(message, bytes):
                if visitor_sent and speaking:
                    response_frames += 1
                continue
            event = json.loads(message)
            print(f'{time.monotonic()-began:.2f}s', json.dumps(event, ensure_ascii=False), flush=True)
            if event.get('type') == 'ready':
                ready = True
                next_tick = time.monotonic()
            elif event.get('type') == 'agent_state':
                speaking = event.get('state') == 'speaking'
                if event.get('state') == 'listening':
                    if visitor_sent and replied and response_frames:
                        break
                    if first_listen is None:
                        first_listen = time.monotonic()
            elif event.get('type') == 'transcript':
                if event.get('speaker') == 'visitor':
                    visitor_transcribed = True
                if visitor_sent and event.get('speaker') == 'ai':
                    replied = True
            elif event.get('type') == 'error':
                break
    finally:
        try:
            ws.send(json.dumps({'type': 'end'}))
        except websocket.WebSocketException:
            pass
        ws.close()
    success = visitor_sent and visitor_transcribed and replied and response_frames > 0
    print(json.dumps({'ok': success, 'visitor_sent': visitor_sent,
        'visitor_transcribed': visitor_transcribed, 'ai_replied': replied,
        'response_audio_frames': response_frames}), flush=True)
    raise SystemExit(0 if success else 1)


if __name__ == '__main__':
    main()
