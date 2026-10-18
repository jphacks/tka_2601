#!/usr/bin/env python3
"""Verify one v2 ASR/reply cycle with a supplied diagnostic PCM WAV.

Uses an unpaired diagnostic ID; does not operate either board or its servos.
Only use audio that may be sent to the configured voice server.
"""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import re
import time
import uuid
import wave

import certifi
import websocket


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('wav',type=Path)
    parser.add_argument('--seconds',type=float,default=90)
    parser.add_argument('--output-dir',type=Path,help='Save diagnostic reply WAVs for listening')
    args=parser.parse_args()
    with wave.open(str(args.wav),'rb') as wav:
        if (wav.getframerate(),wav.getsampwidth(),wav.getnchannels())!=(16000,2,1):
            parser.error('WAV must be 16kHz PCM16LE mono')
        pcm=wav.readframes(wav.getnframes())
    if not pcm or not any(pcm) or len(pcm)>28*32000:
        parser.error('WAV must contain nonzero audio and be at most 28 seconds')
    # Include a real silence boundary, including padding of the last frame.
    frames=[pcm[i:i+640].ljust(640,b'\0') for i in range(0,len(pcm),640)]+[bytes(640)]*60
    config=(Path(__file__).parents[1]/'source/api_config.h').read_text()
    def setting(name):
        match=re.search(r'^#define '+name+r' (".*")$',config,re.M)
        if not match:parser.error('Run configure_api.py first')
        return ast.literal_eval(match[1])
    ws=websocket.create_connection('wss://'+setting('DOOR_API_HOST')+'/api/relay',
        header=['Authorization: Bearer '+setting('DOOR_API_KEY')],
        sslopt={'ca_certs':certifi.where()},timeout=15)
    began=time.monotonic()
    output_turn=output_frames=output_samples=reply_frames=0
    output_pcm=bytearray()
    greeting_digest=None
    input_turn=None
    offset=0
    next_frame=began
    sent=success=False
    def send(kind,**values):ws.send(json.dumps({'type':kind,**values}))
    try:
        send('start',protocol_version=2,visit_id=str(uuid.uuid4()),mode='omakase',device_key='e84-diagnostic-unpaired')
        ws.settimeout(.01)
        while time.monotonic()-began<args.seconds:
            if input_turn is not None and not sent and time.monotonic()>=next_frame:
                ws.send_binary(frames[offset]);offset+=1;next_frame=time.monotonic()+.02
                if offset==len(frames):
                    send('input_end',turn_id=input_turn,frames=offset,samples=offset*320,reason='silence')
                    sent=True
            try:message=ws.recv()
            except websocket.WebSocketTimeoutException:continue
            if not message:break
            if isinstance(message,bytes):
                if not message or len(message)%2:raise RuntimeError('Invalid output PCM')
                output_frames+=1;output_samples+=len(message)//2
                output_pcm.extend(message)
                if sent and output_turn>0:reply_frames+=1
                send('audio_ack',turn_id=output_turn,output_id=output_turn,frames=output_frames)
                continue
            event=json.loads(message)
            print(f'{time.monotonic()-began:.2f}s',json.dumps(event,ensure_ascii=False),flush=True)
            kind=event.get('type')
            if kind=='ready':
                if event.get('protocol_version')!=2:raise RuntimeError('Server does not support v2')
                send('call_started',turn_id=0)
            elif kind=='output_start':
                output_turn=event['turn_id'];output_frames=output_samples=0
                output_pcm.clear()
            elif kind=='output_end':
                if (event['frames'],event['samples'])!=(output_frames,output_samples):
                    raise RuntimeError('Output sample/frame mismatch')
                digest=hashlib.sha256(output_pcm).hexdigest()
                if output_turn==0:greeting_digest=digest
                print(json.dumps({'output_turn':output_turn,'same_as_greeting':digest==greeting_digest}),flush=True)
                if args.output_dir:
                    args.output_dir.mkdir(parents=True,exist_ok=True)
                    with wave.open(str(args.output_dir/f'turn-{output_turn}.wav'),'wb') as wav:
                        wav.setparams((1,2,16000,0,'NONE','not compressed'))
                        wav.writeframes(output_pcm)
                send('playback_done',turn_id=output_turn,output_id=output_turn,frames=output_frames,samples=output_samples)
            elif kind=='listen':
                if sent:
                    success=reply_frames>0;break
                input_turn=event['turn_id'];send('input_start',turn_id=input_turn);next_frame=time.monotonic()+.25
            elif kind=='ping':send('pong',turn_id=event['turn_id'],seq=event['seq'])
            elif kind=='call_end':
                success=sent and reply_frames>0;send('call_ended',turn_id=event['turn_id']);break
            elif kind=='error':break
    finally:
        try:send('end')
        except websocket.WebSocketException:pass
        ws.close()
    print(json.dumps({'ok':success,'input_frames':offset,'reply_audio_frames':reply_frames}),flush=True)
    raise SystemExit(0 if success else 1)


if __name__=='__main__':main()
