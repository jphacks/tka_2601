import json
from pathlib import Path
import tempfile
import unittest
from conversation_history import ConversationHistory

class HistoryTests(unittest.TestCase):
    def test_m5_reason_keeps_digits(self):
        history = ConversationHistory()
        history.record('[VOICE] Preparing streaming call.')
        history.record('[VOICE] Call ending: reason=m5_auth_failed state=0 turn=0 input_ms=0.')
        self.assertEqual(history.snapshot()['session']['reason'], 'm5_auth_failed')

    def test_actual_transcripts_persist_and_reload(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'history.json'
            history = ConversationHistory(path)
            history.record('[VOICE] Preparing streaming call.', '2026-10-18T05:45:00+09:00')
            history.record('[VOICE] Listening: turn 3; max 30s')
            text = '玄関に置いておきました。「確認」\nありがとう'
            history.record('[VOICE] Transcript visitor: '+json.dumps(text,ensure_ascii=False))
            history.record('[VOICE] Transcript ai: "写真をお願いします。"')
            history.record('[VOICE] Server error code: time_limit.')
            history.record('[VOICE] Call ended; chime rearmed.')
            snapshot = history.snapshot()
            self.assertEqual(snapshot['session']['messages'][0]['text'], text)
            self.assertEqual(snapshot['session']['messages'][0]['turn'], 3)
            self.assertEqual(snapshot['session']['reason'], 'time_limit')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            loaded = ConversationHistory(path).snapshot()['session']
            self.assertEqual(loaded, snapshot['session'])
            snapshot['session']['messages'].clear()
            self.assertEqual(len(history.snapshot()['session']['messages']), 2)
            self.assertIsNone(history.snapshot(after=history.revision)['session'])

    def test_limits_and_selection(self):
        history = ConversationHistory()
        for i in range(22):
            history.record('[VOICE] Preparing streaming call.')
            history.record('[VOICE] Transcript visitor: '+json.dumps(str(i)))
        first = history.sessions[0]['id']
        for i in range(202):
            history.record('[VOICE] Transcript ai: '+json.dumps('x'*5000))
        self.assertEqual(len(history.sessions),20)
        self.assertEqual(len(history.snapshot()['session']['messages']),200)
        self.assertEqual(len(history.snapshot()['session']['messages'][0]['text']),4096)
        self.assertEqual(history.snapshot(first)['session']['messages'][0]['text'],'2')
        self.assertIsNone(history.snapshot('unknown')['session'])

    def test_real_stop_reason_survives_cleanup(self):
        history=ConversationHistory()
        history.record('[VOICE] Preparing streaming call.')
        history.record('[VOICE] Server error code: time_limit.')
        history.record('[VOICE] Call ending: reason=server_protocol_error state=4 turn=2 input_ms=1600.')
        history.record('[VOICE] Call stopped; chime detection rearmed.')
        self.assertEqual(history.snapshot()['session']['reason'],'time_limit')
        history.record('[VOICE] Preparing streaming call.')
        history.record('[VOICE] Call ending: reason=microphone_or_send_failed state=6 turn=1 input_ms=300.')
        history.record('[VOICE] Call stopped; chime detection rearmed.')
        self.assertEqual(history.snapshot()['session']['reason'],'microphone_or_send_failed')
        history.record('[VOICE] Preparing streaming call.')
        history.record('[VOICE] Server end reason: turn_limit.')
        history.record('[VOICE] Call ended; chime detection rearmed.')
        self.assertEqual(history.snapshot()['session']['reason'],'turn_limit')

    def test_invalid_file_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'history.json'; path.write_text('invalid')
            history=ConversationHistory(path)
            history.record('[VOICE] Preparing streaming call.')
            self.assertTrue(history.snapshot()['error'])
            self.assertEqual(path.read_text(),'invalid')

    def test_test_motion_is_not_a_conversation(self):
        history=ConversationHistory()
        for line in ['[M5] Servo test pressing: call','[VOICE] Transcript visitor: invalid',
                     '[SERVO] CALL returning','[VOICE] Transcript visitor: ""']:
            history.record(line)
        self.assertEqual(history.snapshot()['sessions'],[])
        history.record('[VOICE] Transcript visitor: "荷物です"')
        history.record('[BOOT] Network task running.')
        self.assertEqual(history.snapshot()['session']['status'],'device_restarted')
        history.record('[VOICE] Preparing streaming call.')
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'history.json'
            path.write_text(json.dumps(history.sessions))
            self.assertEqual(ConversationHistory(path).snapshot()['session']['status'],'monitor_restarted')

if __name__=='__main__': unittest.main()
