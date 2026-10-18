import asyncio
from types import SimpleNamespace
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from door_backend import api, relay_v2
PCM = b'\x01\x00' * 320

class FakeAgent:
    def __init__(self, rules, write, finish, transcript):
        self.rules, self.write, self.finish, self.transcript = rules, write, finish, transcript
        self.recognized = []
        self.played_event = asyncio.Event()
        self.end, self.no_reply, self.closed = False, False, False
        self.text = '宅配便です。'
        self.frames, self.reply_count = 2, 0
    async def start(self): pass
    async def recognize(self, pcm):
        self.recognized.append(pcm)
        await self.transcript('visitor', self.text)
        return self.text
    async def reply(self, text):
        self.reply_count += 1
        if text is not None and self.no_reply: return
        self.played_event.clear()
        for _ in range(self.frames): await self.write(PCM)
        await self.finish()
        await self.played_event.wait()
        await self.transcript('ai', 'はい、どちら様でしょうか。' if text is None else '玄関前にお願いします。')
    def played(self): self.played_event.set()
    def end_after_reply(self): return self.end
    async def aclose(self): self.closed = True

@pytest.fixture
def backend(monkeypatch):
    calls = SimpleNamespace(agents=[], visits=[])
    def factory(*args):
        agent = FakeAgent(*args)
        calls.agents.append(agent)
        return agent
    async def house(_key): return None
    async def write_visit(*args, **kwargs): calls.visits.append((args, kwargs))
    monkeypatch.setattr(relay_v2, 'DeviceAgent', factory)
    monkeypatch.setattr(relay_v2, 'fetch_house_settings', house)
    monkeypatch.setattr(relay_v2, 'write_visit', write_visit)
    return calls

def connect(client):
    return client.websocket_connect('/api/relay', headers={'Authorization': f'Bearer {api.settings.api_key}'})

def start(ws):
    ws.send_json({'type': 'start', 'protocol_version': 2, 'visit_id': str(uuid4()), 'mode': 'away', 'device_key': 'device-key'})
    assert control(ws) == {'type': 'ready', 'protocol_version': 2}

def control(ws):
    while True:
        payload = ws.receive_json()
        if payload.get('type') != 'transcript':
            return payload
        if not hasattr(ws, 'transcripts'):
            ws.transcripts = []
        ws.transcripts.append(payload)

def reply(ws, turn, frames=2, finish=True, end=False):
    assert control(ws) == {'type': 'output_start', 'turn_id': turn, 'output_id': turn}
    for index in range(frames):
        assert ws.receive_bytes() == PCM
        ws.send_json({'type': 'audio_ack', 'turn_id': turn, 'output_id': turn, 'frames': index + 1})
    assert control(ws) == {'type': 'output_end', 'turn_id': turn, 'output_id': turn, 'frames': frames, 'samples': frames * 320, 'end_call': end}
    if finish:
        ws.send_json({'type': 'playback_done', 'turn_id': turn, 'output_id': turn, 'frames': frames, 'samples': frames * 320})

def greeting(ws):
    ws.send_json({'type': 'call_started', 'turn_id': 0})
    reply(ws, 0)
    assert control(ws) == {'type': 'listen', 'turn_id': 1}

def input_turn(ws, turn=1, frames=2, reason='silence'):
    ws.send_json({'type': 'input_start', 'turn_id': turn})
    for _ in range(frames): ws.send_bytes(PCM)
    ws.send_json({'type': 'input_end', 'turn_id': turn, 'frames': frames, 'samples': frames * 320, 'reason': reason})

def test_two_turns_only_listen_after_physical_playback_and_save_history(backend):
    with TestClient(api.app) as client, connect(client) as ws:
        start(ws)
        agent = backend.agents[0]
        assert agent.reply_count == 0
        greeting(ws)
        for turn in (1, 2):
            input_turn(ws, turn)
            reply(ws, turn, finish=False)
            ws.send_json({'type': 'ping', 'turn_id': turn, 'seq': 7})
            assert control(ws) == {'type': 'pong', 'turn_id': turn, 'seq': 7}
            assert not agent.played_event.is_set()
            ws.send_json({'type': 'playback_done', 'turn_id': turn, 'output_id': turn, 'frames': 2, 'samples': 640})
            assert control(ws) == {'type': 'listen', 'turn_id': turn + 1}
        ws.send_json({'type': 'end'})
    assert agent.recognized == [PCM * 2, PCM * 2]
    assert agent.closed
    assert [u['speaker'] for u in ws.transcripts] == ['ai', 'visitor', 'ai', 'visitor', 'ai']
    assert ws.transcripts[1]['text'] == '宅配便です。'
    assert [u['speaker'] for u in backend.visits[0][1]['utterances']] == ['ai', 'visitor', 'ai', 'visitor', 'ai']

def test_final_reply_waits_for_playback_then_end_button(backend):
    with TestClient(api.app) as client, connect(client) as ws:
        start(ws); greeting(ws)
        backend.agents[0].end = True
        input_turn(ws); reply(ws, 1, finish=False, end=True)
        ws.send_json({'type': 'ping', 'turn_id': 1, 'seq': 3})
        assert control(ws)['type'] == 'pong'
        ws.send_json({'type': 'playback_done', 'turn_id': 1, 'output_id': 1, 'frames': 2, 'samples': 640})
        assert control(ws) == {'type': 'call_end', 'turn_id': 1, 'reason': 'completed'}
        ws.send_json({'type': 'call_ended', 'turn_id': 1})
        with pytest.raises(WebSocketDisconnect) as error: control(ws)
        assert error.value.code == 1000

def test_no_reply_has_no_fabricated_audio_and_resumes(backend):
    with TestClient(api.app) as client, connect(client) as ws:
        start(ws); greeting(ws)
        backend.agents[0].no_reply = True
        input_turn(ws)
        assert control(ws) == {'type': 'no_reply', 'turn_id': 1}
        assert control(ws) == {'type': 'listen', 'turn_id': 2}
        ws.send_json({'type': 'cancel'})

@pytest.mark.parametrize('payload', [
    {'type': 'input_start', 'turn_id': 0},
    {'type': 'input_end', 'turn_id': 1, 'frames': 0, 'samples': 0, 'reason': 'silence'},
    {'type': 'playback_done', 'turn_id': 1, 'output_id': 1, 'frames': 2, 'samples': 640},
])
def test_rejects_state_and_generation_mismatch(backend, payload):
    with TestClient(api.app) as client, connect(client) as ws:
        start(ws); greeting(ws)
        ws.send_json(payload)
        assert control(ws)['type'] == 'error'

@pytest.mark.parametrize('frames,samples,reason', [(1, 320, 'silence'), (2, 639, 'silence'), (2, 640, 'max_duration'), (2, 640, 'other')])
def test_input_end_validates_exact_consumed_audio(backend, frames, samples, reason):
    with TestClient(api.app) as client, connect(client) as ws:
        start(ws); greeting(ws)
        ws.send_json({'type': 'input_start', 'turn_id': 1})
        ws.send_bytes(PCM); ws.send_bytes(PCM)
        ws.send_json({'type': 'input_end', 'turn_id': 1, 'frames': frames, 'samples': samples, 'reason': reason})
        assert control(ws)['type'] == 'error'
    assert backend.agents[0].recognized == []

def test_accepts_exact_thirty_seconds_and_rejects_overrun(backend):
    with TestClient(api.app) as client, connect(client) as ws:
        start(ws); greeting(ws)
        input_turn(ws, frames=1500, reason='max_duration')
        reply(ws, 1)
        assert control(ws)['turn_id'] == 2
        ws.send_json({'type': 'input_start', 'turn_id': 2})
        for _ in range(1501): ws.send_bytes(PCM)
        assert control(ws)['code'] == 'input_limit'
    assert len(backend.agents[0].recognized) == 1
    assert len(backend.agents[0].recognized[0]) == 960000

def test_pcm_is_forbidden_while_m5_is_playing(backend):
    with TestClient(api.app) as client, connect(client) as ws:
        start(ws)
        ws.send_json({'type': 'call_started', 'turn_id': 0})
        reply(ws, 0, finish=False)
        ws.send_bytes(PCM)
        assert control(ws)['code'] == 'invalid_audio'
    assert backend.agents[0].closed

def test_large_output_is_bounded_by_ack_window_but_keepalive_works(backend):
    with TestClient(api.app) as client, connect(client) as ws:
        start(ws)
        backend.agents[0].frames = 15
        ws.send_json({'type': 'call_started', 'turn_id': 0})
        assert control(ws)['type'] == 'output_start'
        for _ in range(10): assert ws.receive_bytes() == PCM
        ws.send_json({'type': 'ping', 'turn_id': 0, 'seq': 1})
        assert control(ws)['type'] == 'pong'
        ws.send_json({'type': 'audio_ack', 'turn_id': 0, 'output_id': 0, 'frames': 10})
        for _ in range(5): assert ws.receive_bytes() == PCM
        assert control(ws)['frames'] == 15
        ws.send_json({'type': 'cancel'})
    assert backend.agents[0].closed

def test_unacknowledged_playback_done_is_rejected(backend):
    with TestClient(api.app) as client, connect(client) as ws:
        start(ws)
        ws.send_json({'type': 'call_started', 'turn_id': 0})
        assert control(ws)['type'] == 'output_start'
        ws.receive_bytes(); ws.receive_bytes(); control(ws)
        ws.send_json({'type': 'playback_done', 'turn_id': 0, 'output_id': 0, 'frames': 2, 'samples': 640})
        assert control(ws)['code'] == 'invalid_playback'

def test_input_start_waits_for_first_speech_before_recording_deadline():
    class Socket:
        async def send_json(self, payload): pass
    async def scenario():
        start = relay_v2.StartMessage(type='start', protocol_version=2, visit_id=uuid4(), mode='normal', device_key='key')
        call = relay_v2.DeviceConversation(Socket(), start)
        call.state, call.turn = 'listening', 1
        before = asyncio.get_running_loop().time()
        await call.received({'type': 'websocket.receive', 'text': '{"type":"input_start","turn_id":1}'})
        assert 59 < call._deadline - before <= 61
        assert call._pcm_deadline == call._deadline
        await call.received({'type': 'websocket.receive', 'bytes': PCM})
        current = asyncio.get_running_loop().time()
        assert 34 < call._deadline - current <= 35
        assert 4 < call._pcm_deadline - current <= 5
    asyncio.run(scenario())


def test_turn_limit_hangs_up_with_current_generation():
    messages = []
    class Socket:
        async def send_json(self, payload): messages.append(payload)
    async def scenario():
        start = relay_v2.StartMessage(type='start', protocol_version=2, visit_id=uuid4(), mode='normal', device_key='key')
        call = relay_v2.DeviceConversation(Socket(), start)
        call.turn = 20
        await call.listen()
        assert call.turn == 20
    asyncio.run(scenario())
    assert messages == [{'type': 'call_end', 'turn_id': 20, 'reason': 'turn_limit'}]


@pytest.mark.parametrize('text', ['荷物を玄関に置きました。', '日' * 2000, '😀\\\n"' * 1000])
def test_transcript_event_is_bounded_and_full_history_is_preserved(text):
    import json
    messages = []
    class Socket:
        async def send_json(self, payload): messages.append(payload)
    async def scenario():
        start = relay_v2.StartMessage(type='start', protocol_version=2, visit_id=uuid4(), mode='normal', device_key='key')
        call = relay_v2.DeviceConversation(Socket(), start)
        await call.transcript('visitor', text)
        assert call.utterances[0]['text'] == text
    asyncio.run(scenario())
    assert len(messages) == 1
    payload = messages[0]
    assert payload['type'] == 'transcript' and payload['speaker'] == 'visitor'
    assert text.startswith(payload['text']) and payload['text']
    assert len(json.dumps(payload, ensure_ascii=True).encode('utf-8')) <= 1024
