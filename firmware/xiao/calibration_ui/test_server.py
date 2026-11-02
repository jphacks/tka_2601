import json
import os
import pty
import select
import threading
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from conversation_history import ConversationHistory
from http.server import ThreadingHTTPServer

from server import command_for, handler_for, SerialLink


class FakeLink:
    def __init__(self):
        self.commands = []
        self.history = ConversationHistory()

    def command(self, value):
        self.commands.append(value)
        return {'ok': True, 'active': value == '@begin'}

    def mic(self):
        self.commands.append('m')
        return {'status': 1, 'rms': 123.0}


def open_link(port=None):
    """A real SerialLink on a pty; the test's master end plays the device."""
    master, slave = pty.openpty()
    link = SerialLink(port or os.ttyname(slave))
    link.command_timeout = .1 # no device answers @cancel while closing
    deadline = time.monotonic()+3
    while not link.snapshot()['connected'] and time.monotonic()<deadline:
        time.sleep(.01)
    return link, master, slave


def read_line(master, timeout=2):
    """Read one complete command written by the server."""
    line = bytearray()
    while not line.endswith(b'\n'):
        assert select.select([master], [], [], timeout)[0], 'no command from server'
        line += os.read(master, 1)
    return bytes(line)


class CalibrationUITests(unittest.TestCase):
    def test_recovery_releases_diagnostics_but_preserves_warning(self):
        link = SerialLink('/nonexistent-test-port')
        try:
            link.record('[VOICE] Preparing streaming call.')
            self.assertTrue(link.snapshot()['voice_active'])
            link.record('[VOICE] Playback/call state uncertain. Recording remains paused. Check intercom and reset the board. Diagnostics available.')
            self.assertFalse(link.snapshot()['voice_active'])
            self.assertTrue(link.snapshot()['recovery_required'])
            link.record('[DIAG] usb ok=1')
            self.assertTrue(link.snapshot()['recovery_required'])
            link.record('[BOOT] Network task running.')
            self.assertFalse(link.snapshot()['recovery_required'])
            link.record('[VOICE] Playback/call state uncertain. Recording remains paused. Check intercom and reset the board.')
            self.assertTrue(link.snapshot()['voice_active']) # Without the release statement, stay busy.
        finally:
            link.close()

    def test_diagnostic_exchange_ignores_old_success_and_other_replies(self):
        link, master, slave = open_link()
        try:
            self.assertEqual(read_line(master), b's\n')
            link.record('[DIAG] usb ok=1')
            with self.assertRaises(TimeoutError):
                link.exchange('u', lambda text:text.startswith('[DIAG] usb '), .08)
            self.assertEqual(read_line(master), b'u\n')
            def device():
                assert read_line(master)==b'n\n'
                os.write(master,b'[DIAG] usb ok=1\n[DIAG] wifi {"connected":false}\n')
            worker=threading.Thread(target=device);worker.start()
            lines, reply=link.exchange('n', lambda text:text.startswith('[DIAG] wifi '), 2)
            worker.join()
            self.assertIn('"connected":false',reply)
            self.assertTrue(any('usb ok=1' in row['text'] for row in lines))
        finally:
            link.close();os.close(master);os.close(slave)

    def test_exchange_reports_board_restart(self):
        link, master, slave = open_link()
        try:
            read_line(master)
            def device():
                assert read_line(master)==b'a\n'
                os.write(master,b'[BOOT] Network task running.\n')
            worker=threading.Thread(target=device);worker.start()
            with self.assertRaises(OSError):
                link.exchange('a', lambda text:text.startswith('[DIAG] api_https '), 2)
            worker.join()
        finally:
            link.close();os.close(master);os.close(slave)

    def test_missing_usb_does_not_prevent_start_and_reconnect(self):
        with tempfile.TemporaryDirectory() as directory:
            port=Path(directory)/'xiao-port'
            link=SerialLink(str(port))
            deadline=time.monotonic()+1
            while not link.snapshot()['lines'] and time.monotonic()<deadline: time.sleep(.01)
            self.assertIsNone(link.fd)
            self.assertFalse(link.snapshot()['connected'])
            with self.assertRaises(OSError): link.command('@get')
            first=[line['text'] for line in link.snapshot()['lines']]
            self.assertEqual(len(first),1)
            master,slave=pty.openpty();port.symlink_to(os.ttyname(slave))
            def device():
                assert read_line(master,4)==b's\n'
                for expected in (b'@get\n',b'@cancel\n'):
                    assert read_line(master,4)==expected
                    os.write(master,b'[CAL] {"ok":true,"active":false,"saved":{}}\n')
            worker=threading.Thread(target=device);worker.start()
            try:
                deadline=time.monotonic()+4
                while not link.snapshot()['connected'] and time.monotonic()<deadline: time.sleep(.01)
                self.assertTrue(link.command('@get')['ok'])
            finally:
                link.close();worker.join();os.close(master);os.close(slave)

    def test_usb_live_logs_and_console_allowlist(self):
        link, master, slave = open_link()
        try:
            self.assertTrue(link.snapshot()['connected'])
            self.assertEqual(read_line(master), b's\n')
            os.write(master, b'[DETECTED] Chime count=1\r\n[VOICE] Listening: turn 1; max 30s\r\n')
            deadline = time.monotonic()+3
            while '聞き取り中' not in link.snapshot()['stage'] and time.monotonic()<deadline:
                time.sleep(.01)
            state = link.snapshot()
            self.assertIn('聞き取り中', state['stage'])
            self.assertTrue(any('[DETECTED]' in line['text'] for line in state['lines']))
            self.assertEqual(link.snapshot(state['next'])['lines'], [])
            self.assertTrue(link.snapshot(100000)['lines']) # browser recovers after restart
            link.record('[BOOT] Network task running.')
            self.assertIn('ネットワーク接続待ち', link.snapshot()['stage'])
            link.record('[SERVER] Authenticated HTTPS status check passed.')
            self.assertIn('接続OK', link.snapshot()['stage'])
            link.record('[VOICE] Preparing streaming call.')
            link.record('[SERVER] Authenticated HTTPS status check passed.')
            self.assertEqual(link.snapshot()['stage'], '通話を準備中') # late health response cannot hide a call
            with self.assertRaises(ValueError):
                link.send('c') # a chime test cannot be silently bypassed with a manual call
            with self.assertRaises(ValueError):
                link.send('q\nc')
            for command in ('1', '2', '3', 'r', 'v', 'm'): # servo presses go through @test; the mic has its own reply
                with self.assertRaises(ValueError):
                    link.send(command)
            link.send('q')
            self.assertEqual(read_line(master), b'q\n')
            for command in ('e', 'x', 't', 'l'):
                link.send(command)
                self.assertEqual(read_line(master), command.encode()+b'\n')
                self.assertIn(f'[WEB] {command}:', link.snapshot()['lines'][-1]['text'])
        finally:
            link.close(); os.close(slave); os.close(master)

    def test_voice_stages_use_the_speaker_on_this_board(self):
        link = SerialLink('/nonexistent-test-port')
        try:
            for line, stage in [
                ('[VOICE] Response 0: recording paused, playing on speaker.', 'スピーカーで挨拶を再生中'),
                ('[VOICE] Response 2: recording paused, playing on speaker.', 'スピーカーで返答を再生中'),
                ('[VOICE] Output ended: 40 frames; waiting for playback completion.', 'スピーカーの再生完了を待機'),
                ('[VOICE] Playback complete: turn 2.', 'スピーカーの再生完了'),
                ('[VOICE] Input streaming: sent=500 ms queued=1 frames rms=20.', 'XIAOマイクの音声を送信中'),
                ('[SERVO] CALL press once: angle=30', '通話ボタンを1回押しています'),
                ('[VOICE] Call ended; chime detection rearmed.', '会話終了・次のチャイムを待機'),
            ]:
                link.record(line)
                self.assertEqual(link.snapshot()['stage'], stage)
            self.assertFalse(link.snapshot()['voice_active'])
            link.record('[SETUP] Ring the intercom once (1/3). Gate=120.')
            self.assertEqual(link.snapshot()['stage'], 'Ring the intercom once (1/3). Gate=120.')
        finally:
            link.close()

    def test_calibration_state_follows_replies_and_status_lines(self):
        link, master, slave = open_link()
        try:
            read_line(master)
            self.assertIsNone(link.snapshot()['calibration_active'])
            os.write(master, b'[STREAM] USB angle calibration; calls paused\n')
            deadline = time.monotonic()+2
            while link.snapshot()['calibration_active'] is not True and time.monotonic()<deadline: time.sleep(.01)
            self.assertTrue(link.snapshot()['calibration_active'])
            link.record('[STREAM] Calibration timed out; unsaved angles discarded')
            self.assertFalse(link.snapshot()['calibration_active'])
            link.record('[STREAM] USB angle calibration; calls paused')
            link.record('[STREAM] Servo angles saved')
            self.assertFalse(link.snapshot()['calibration_active'])
            self.assertTrue(any(line['text']=='[MODE] calibration=active' for line in link.snapshot()['lines']))
            def device():
                assert read_line(master)==b'@begin\n'
                os.write(master,b'[CAL] {"ok":true,"active":true}\n')
            worker=threading.Thread(target=device);worker.start()
            self.assertTrue(link.command('@begin')['active'])
            worker.join()
            self.assertTrue(link.snapshot()['calibration_active'])
        finally:
            link.close(); os.close(slave); os.close(master)

    def test_validated_hardware_commands(self):
        self.assertEqual(command_for('mirror', {'target':'e'}), '@mirror e')
        self.assertEqual(command_for('angles', {'target':'e','rest':0,'press':17}), '@angles e 0 17')
        self.assertEqual(command_for('angles', {'target':'u','rest':10,'press':40}), '@angles u 10 40')
        for body in [{'target':'c'},{'target':'u'},{'target':'e\\n1'},{}]:
            with self.assertRaises(ValueError): command_for('mirror',body)
        for body in [{'target':'e','rest':-1,'press':17},{'target':'e','rest':0,'press':181},
                     {'target':'e','rest':True,'press':17},{'target':'x','rest':0,'press':17}]:
            with self.assertRaises(ValueError): command_for('angles',body)
        self.assertEqual(command_for('test', {'target': 'c'}), '@test c')
        self.assertEqual(command_for('test', {'target': 'e'}), '@test e')
        self.assertEqual(command_for('test', {'target': 'u'}), '@test u')
        self.assertEqual(command_for('stop_test', {}), '@stop')
        for target in ['c\\n1', 'x', None, True]:
            with self.assertRaises(ValueError):
                command_for('test', {'target':target})
        self.assertEqual(command_for('preview', {'target': 'e', 'position': 'p', 'angle': 145}), '@set e p 145')
        self.assertEqual(command_for('preview', {'target': 'u', 'position': 'r', 'angle': 5}), '@set u r 5')
        for angle in [-1, 181, 1.5, True, '90\n1']:
            with self.assertRaises(ValueError):
                command_for('preview', {'target': 'c', 'position': 'p', 'angle': angle})
        with self.assertRaises(ValueError):
            command_for('reset', {})
        self.assertEqual(command_for('timing', {'field':'call_delay_ms','value':3000}), '@time d 3000')
        self.assertEqual(command_for('timing', {'field':'call_hold_ms','value':200}), '@time c 200')
        self.assertEqual(command_for('timing', {'field':'end_hold_ms','value':2000}), '@time e 2000')
        self.assertEqual(command_for('timing', {'field':'unlock_hold_ms','value':100}), '@time u 100')
        self.assertEqual(command_for('timing', {'field':'return_ms','value':3000}), '@time r 3000')
        for field,value in [('call_delay_ms',-1),('call_delay_ms',30001),('call_hold_ms',99),('end_hold_ms',2001),('unlock_hold_ms',99),('unlock_hold_ms',2001),('return_ms',3001),('bad',1),('call_delay_ms',True),('call_delay_ms',1.5)]:
            with self.assertRaises(ValueError):
                command_for('timing', {'field':field,'value':value})

    def test_background_logs_and_command_replies_share_one_port(self):
        link, master, slave = open_link()
        def device():
            assert read_line(master)==b'@time c 200\n'
            os.write(master,b'[SERVO] CALL returning\r\n[CAL] {"ok":true,"call_hold_ms":200}\n')
        worker = threading.Thread(target=device)
        try:
            self.assertEqual(read_line(master), b's\n')
            os.write(master,b'[SERVO] CALL waiting 3000 ms\r\n')
            texts=lambda:[line['text'] for line in link.snapshot()['lines']]
            deadline=time.monotonic()+2
            while not any('CALL waiting' in line for line in texts()) and time.monotonic()<deadline: time.sleep(.01)
            self.assertTrue(any('CALL waiting' in line for line in texts()))
            worker.start()
            link.command_timeout = 2
            self.assertEqual(link.command('@time c 200')['call_hold_ms'],200)
            worker.join()
            self.assertTrue(any('CALL returning' in x for x in texts()))
            self.assertFalse(any('[CAL]' in x for x in texts()))
            link.command_timeout = .1
        finally:
            link.close(); os.close(slave); os.close(master)

    def test_stale_and_malformed_replies_do_not_answer_a_command(self):
        link, master, slave = open_link()
        try:
            self.assertEqual(read_line(master), b's\n')
            os.write(master,b'[CAL] {"ok":true,"stale":true}\n')
            deadline=time.monotonic()+2
            while link.replies['[CAL]'] is None and time.monotonic()<deadline: time.sleep(.01)
            def device():
                assert read_line(master)==b'@get\n'
                os.write(master,b'[CAL] not json\n[CAL] [1]\n[CAL] {"ok":true,"fresh":true}\n')
            worker=threading.Thread(target=device);worker.start()
            link.command_timeout = 2
            self.assertTrue(link.command('@get')['fresh'])
            worker.join()
            self.assertTrue(link.snapshot()['connected'])
            self.assertEqual(sum('不正な[CAL]応答' in line['text'] for line in link.snapshot()['lines']),2)
            link.command_timeout = .05
            with self.assertRaises(TimeoutError): link.command('@get')
        finally:
            link.close(); os.close(slave); os.close(master)

    def test_mic_reply_is_returned_and_polling_stays_out_of_the_log(self):
        link, master, slave = open_link()
        reply = (b'[DIAG] mic {"status":1,"rms":123.0,"pcm_min":-100,"pcm_max":100,"errors":0,'
                 b'"detected":0,"last_score":-1.000,"model":false,"threshold":0.000,"gate":0.0}\r\n')
        def device():
            assert read_line(master)==b'm\n'
            os.write(master,reply+b'[DIAG] usb ok=1\n')
        worker=threading.Thread(target=device)
        try:
            self.assertEqual(read_line(master), b's\n')
            before=link.snapshot()['next']
            worker.start()
            link.command_timeout = 2
            state=link.mic()
            worker.join()
            self.assertEqual((state['status'],state['rms'],state['pcm_min'],state['last_score'],state['model']),(1,123.0,-100,-1.0,False))
            deadline=time.monotonic()+2
            while not link.snapshot(before)['lines'] and time.monotonic()<deadline: time.sleep(.01)
            self.assertEqual([line['text'] for line in link.snapshot(before)['lines']],['[DIAG] usb ok=1'])
            link.command_timeout = .05
            with self.assertRaises(TimeoutError): link.mic()
        finally:
            link.close(); os.close(slave); os.close(master)

    def test_mic_and_calibration_replies_do_not_answer_each_other(self):
        link, master, slave = open_link()
        def device():
            assert read_line(master)==b'@tune get\n'
            os.write(master,b'[DIAG] mic {"status":0}\n[CAL] {"ok":true,"diagnostic":"tune","speaker_volume":70}\n')
            assert read_line(master)==b'm\n'
            os.write(master,b'[CAL] {"ok":true}\n[DIAG] mic not-json\n[DIAG] mic {"status":2}\n')
        worker=threading.Thread(target=device)
        try:
            self.assertEqual(read_line(master), b's\n')
            worker.start()
            link.command_timeout = 2
            self.assertEqual(link.command('@tune get')['speaker_volume'],70)
            self.assertEqual(link.mic()['status'],2)
            worker.join()
            self.assertTrue(any('不正な[DIAG] mic応答' in line['text'] for line in link.snapshot()['lines']))
            link.command_timeout = .05
        finally:
            link.close(); os.close(slave); os.close(master)

    def test_tune_commands_are_range_checked(self):
        for field,value in [('volume',0),('volume',100),('gate',30),('gate',32767),('margin',50),('margin',200)]:
            self.assertEqual(command_for('tune',{'field':field,'value':value}),f'@tune {field} {value}')
        for field,value in [('volume',-1),('volume',101),('gate',29),('gate',32768),('margin',49),('margin',201),
                            ('volume',True),('volume',1.5),('volume','70'),('volume\n@save',1),('get',0),(None,1)]:
            with self.assertRaises(ValueError):
                command_for('tune',{'field':field,'value':value})

    def test_mic_and_tune_http_api(self):
        link = FakeLink()
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(link))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        url = f'http://127.0.0.1:{server.server_port}'
        def post(body, origin=url):
            request = urllib.request.Request(url+'/api/tune', data=json.dumps(body).encode(),
                headers={'Origin': origin, 'Content-Type': 'application/json'})
            return json.load(urllib.request.urlopen(request))
        try:
            self.assertEqual(json.load(urllib.request.urlopen(url+'/api/mic')),{'ok':True,'status':1,'rms':123.0})
            self.assertEqual(link.commands,['m'])
            self.assertTrue(json.load(urllib.request.urlopen(url+'/api/tune'))['ok'])
            self.assertEqual(link.commands[-1],'@tune get')
            self.assertTrue(post({'field':'volume','value':70})['ok'])
            self.assertEqual(link.commands[-1],'@tune volume 70')
            before=list(link.commands)
            for body,origin,status in [({'field':'gate','value':29},url,400),({'field':'margin','value':201},url,400),
                                       ({'field':'volume','value':70},'https://example.com',403)]:
                with self.assertRaises(urllib.error.HTTPError) as caught: post(body,origin)
                self.assertEqual(caught.exception.code,status)
            self.assertEqual(link.commands,before)
            def offline(*args): raise OSError('未接続')
            link.mic=link.command=offline
            for path in ('/api/mic','/api/tune'):
                with self.assertRaises(urllib.error.HTTPError) as caught: urllib.request.urlopen(url+path)
                self.assertEqual(caught.exception.code,503)
        finally:
            server.shutdown(); server.server_close(); worker.join()

    def test_only_local_json_actions_reach_hardware(self):
        link = FakeLink()
        link.history.record('[VOICE] Transcript visitor: "荷物を置きました"')
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(link))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        url = f'http://127.0.0.1:{server.server_port}'
        def post(origin, action, body):
            request = urllib.request.Request(url + '/api/' + action, data=json.dumps(body).encode(),
                headers={'Origin': origin, 'Content-Type': 'application/json'})
            return json.load(urllib.request.urlopen(request))
        try:
            self.assertTrue(json.load(urllib.request.urlopen(url+'/api/state'))['ok'])
            self.assertEqual(link.commands, ['@get'])
            self.assertTrue(post(url,'mirror',{'target':'e'})['ok'])
            self.assertEqual(link.commands[-1],'@mirror e')
            conversation = json.load(urllib.request.urlopen(url+'/api/conversations'))
            self.assertEqual(conversation['session']['messages'][0]['text'], '荷物を置きました')
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(url+'/api/conversations?after=bad')
            self.assertEqual(caught.exception.code,400)
            self.assertTrue(post(url, 'test', {'target':'c'})['ok'])
            self.assertEqual(link.commands[-1], '@test c')
            self.assertTrue(post(url, 'test', {'target':'u'})['ok'])
            self.assertEqual(link.commands[-1], '@test u')
            self.assertTrue(post(url, 'stop_test', {})['ok'])
            self.assertEqual(link.commands[-1], '@stop')
            self.assertTrue(post(url, 'begin', {})['active'])
            before = list(link.commands)
            for origin, action, body, status in [
                ('https://example.com', 'save', {}, 403),
                (url, 'preview', {'target': 'c', 'position': 'p', 'angle': 999}, 400),
            ]:
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    post(origin, action, body)
                self.assertEqual(caught.exception.code, status)
            self.assertEqual(link.commands, before)
            self.assertFalse(post(url, 'save', {})['active'])
        finally:
            server.shutdown(); server.server_close(); worker.join()


if __name__ == '__main__':
    unittest.main()
