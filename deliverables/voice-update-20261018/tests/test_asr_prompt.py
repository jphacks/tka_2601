from types import SimpleNamespace
from door_backend import agent


def test_kotoba_receives_domain_vocabulary_without_previous_transcript(monkeypatch):
    calls=[]
    monkeypatch.setattr(agent,'settings',SimpleNamespace(asr_model='kotoba-tech/kotoba-whisper-v2.1',asr_base_url='http://127.0.0.1:18095'))
    monkeypatch.setattr(agent.openai,'STT',lambda **kwargs: calls.append(kwargs) or kwargs)
    agent._stt()
    assert calls[0]['prompt']==agent.ASR_PROMPT
    assert '宅配便' in calls[0]['prompt'] and '荷物' in calls[0]['prompt']
    assert calls[0]['language']=='ja' and calls[0]['use_realtime'] is False
