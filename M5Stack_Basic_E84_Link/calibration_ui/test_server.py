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
from types import SimpleNamespace
from pathlib import Path
from conversation_history import ConversationHistory
from http.server import ThreadingHTTPServer

from server import command_for, handler_for, E84Monitor, SerialBridge


class Bridge:
    def __init__(self):
        self.commands = []

    def command(self, value):
        self.commands.append(value)
        return {'ok': True, 'active': value == '@begin'}


class CalibrationUITests(unittest.TestCase):
    def test_recovery_releases_diagnostics_but_preserves_warning(self):
        monitor = E84Monitor('/nonexistent-test-port')
        try:
            monitor.record('[VOICE] Preparing streaming call.')
            self.assertTrue(monitor.snapshot()['voice_active'])
            monitor.record('[VOICE] Playback/call state uncertain. Recording remains paused. Check intercom and reset both boards. Diagnostics available.')
            self.assertFalse(monitor.snapshot()['voice_active'])
            self.assertTrue(monitor.snapshot()['recovery_required'])
            monitor.record('[M5] PONG received.')
            self.assertTrue(monitor.snapshot()['recovery_required'])
            monitor.record('[BOOT] Network task running.')
            self.assertFalse(monitor.snapshot()['recovery_required'])
            monitor.record('[VOICE] Playback/call state uncertain. Recording remains paused. Check intercom and reset both boards.')
            self.assertTrue(monitor.snapshot()['voice_active']) # Old firmware still latches busy.
        finally:
            monitor.close()

    def test_diagnostic_exchange_ignores_old_success_and_other_replies(self):
        master, slave = pty.openpty()
        monitor = E84Monitor(os.ttyname(slave))
        try:
            deadline=time.monotonic()+2
            while not monitor.snapshot()['connected'] and time.monotonic()<deadline: time.sleep(.01)
            self.assertTrue(select.select([master], [], [], 1)[0]); os.read(master,128)
            monitor.record('[DIAG] usb ok=1')
            with self.assertRaises(TimeoutError):
                monitor.exchange('u', lambda text:text.startswith('[DIAG] usb '), .08)
            self.assertEqual(os.read(master,128),b'u')
            def device():
                assert select.select([master], [], [], 1)[0]
                assert os.read(master,128)==b'n'
                os.write(master,b'[DIAG] usb ok=1\n[DIAG] wifi {"connected":false}\n')
            worker=threading.Thread(target=device);worker.start()
            lines, reply=monitor.exchange('n', lambda text:text.startswith('[DIAG] wifi '), 2)
            worker.join()
            self.assertIn('"connected":false',reply)
            self.assertTrue(any('usb ok=1' in row['text'] for row in lines))
        finally:
            monitor.close();os.close(master);os.close(slave)

    def test_missing_m5_usb_does_not_prevent_start_and_reconnect(self):
        with tempfile.TemporaryDirectory() as directory:
            port=Path(directory)/'m5-port'
            bridge=SerialBridge(str(port))
            self.assertIsNone(bridge.fd)
            with self.assertRaises(OSError): bridge.command('@get')
            master,slave=pty.openpty();port.symlink_to(os.ttyname(slave))
            def device():
                for expected in (b'@get\n',b'@cancel\n'):
                    assert select.select([master], [], [], 2)[0]
                    assert os.read(master,128)==expected
                    os.write(master,b'[CAL] {"ok":true,"active":false,"saved":{}}\n')
            worker=threading.Thread(target=device);worker.start()
            try:
                self.assertTrue(bridge.command('@get')['ok'])
            finally:
                bridge.close();worker.join();os.close(master);os.close(slave)

    def test_board_link_requires_round_trip_and_invalidates_old_evidence(self):
        master, slave = pty.openpty()
        monitor = E84Monitor(os.ttyname(slave))
        try:
            deadline = time.monotonic()+3
            while not monitor.snapshot()['connected'] and time.monotonic()<deadline:
                time.sleep(.01)
            monitor.record('[M5 USB] [STATUS] Wi-Fi=connected IP=172.20.10.2 UDP=8768/ready ping=1 chime=0 duplicate=2 rejected=0')
            self.assertEqual(monitor.snapshot()['board_link']['state'], 'unknown')
            monitor.record('[M5] Testing 172.20.10.2:8768; waiting for authenticated pong...')
            self.assertEqual(monitor.snapshot()['board_link']['state'], 'checking')
            monitor.record('[M5 USB] [LINK] Ping received; pong sent. peer=172.20.10.3:62512')
            self.assertEqual(monitor.snapshot()['board_link']['state'], 'checking')
            monitor.record('[M5] No authenticated reply (3/3 pings submitted).')
            monitor.record('[M5 USB] [LINK] Ping received; pong sent. peer=172.20.10.3:62512 (retry)')
            self.assertEqual(monitor.snapshot()['board_link']['state'], 'failed')
            monitor.record('[M5] PONG received. E84 <-> M5Stack Wi-Fi communication OK.')
            result = monitor.snapshot()
            self.assertEqual(result['board_link']['state'], 'confirmed')
            self.assertIsNotNone(result['board_link']['last_success_at'])
            self.assertTrue(any('[E84↔M5] 連携確認済み' in x['text'] for x in result['lines']))
            monitor.link_last_ok_tick -= 61
            self.assertEqual(monitor.snapshot()['board_link']['state'], 'stale')
            monitor.record('[M5 USB] [STREAM] E84 authenticated')
            monitor.record('[M5 USB] [LINK] Chime received. score=0.1 peer=172.20.10.3:62512')
            self.assertEqual(monitor.snapshot()['board_link']['state'], 'stale')
            monitor.record('[VOICE] Call button operation complete; now connecting voice agent.')
            self.assertEqual(monitor.snapshot()['board_link']['state'], 'confirmed')
            monitor.record('[VOICE] Call ending: reason=m5_connection_lost state=1 turn=1 input_ms=0.')
            self.assertEqual(monitor.snapshot()['board_link']['state'], 'failed')
            monitor.record('[BOOT] Network task running.')
            self.assertEqual(monitor.snapshot()['board_link']['state'], 'unknown')
            monitor.record('[VOICE] M5 playback complete: turn 1.')
            self.assertEqual(monitor.snapshot()['board_link']['state'], 'confirmed')
            monitor.record('[M5 USB] [Wi-Fi] Disconnected; reconnecting automatically.')
            self.assertEqual(monitor.snapshot()['board_link']['state'], 'unknown')
            monitor.record('[M5] PONG received. E84 <-> M5Stack Wi-Fi communication OK.')
            monitor.record('[Wi-Fi] Connection lost; WCM will reconnect.')
            self.assertEqual(monitor.snapshot()['board_link']['state'], 'unknown')
            monitor.record('[M5 MODE] calibration=active')
            monitor.record('[VOICE] Call ending: reason=m5_auth_failed state=0 turn=0 input_ms=0.')
            self.assertEqual(monitor.snapshot()['board_link']['state'], 'blocked')
            self.assertIn('角度調整中', monitor.snapshot()['board_link']['detail'])
            monitor.record('[M5 MODE] calibration=idle')
            self.assertFalse(monitor.snapshot()['calibration_active'])
            self.assertEqual(monitor.snapshot()['board_link']['state'], 'unknown')
            monitor.record('[M5 TCP] Checking voice connection; no buttons, microphone or agent started.')
            self.assertEqual(monitor.snapshot()['board_link']['state'], 'checking')
            monitor.record('[M5 TCP] OK: authenticated HELLO/READY and PING/PONG; no buttons operated.')
            self.assertEqual(monitor.snapshot()['board_link']['state'], 'confirmed')
            self.assertIn('TCP', monitor.snapshot()['board_link']['detail'])
        finally:
            monitor.close(); os.close(slave); os.close(master)

    def test_uart_live_logs_and_console_allowlist(self):
        master, slave = pty.openpty()
        monitor = E84Monitor(os.ttyname(slave))
        try:
            deadline = time.monotonic()+3
            while not monitor.snapshot()['connected'] and time.monotonic()<deadline:
                time.sleep(.01)
            self.assertTrue(monitor.snapshot()['connected'])
            self.assertTrue(select.select([master], [], [], 1)[0])
            self.assertIn(b's', os.read(master, 128))
            os.write(master, b'[DETECTED] Chime count=1\r\n[VOICE] Listening: turn 1; max 30s\r\n')
            while '聞き取り中' not in monitor.snapshot()['stage'] and time.monotonic()<deadline:
                time.sleep(.01)
            state = monitor.snapshot()
            self.assertIn('聞き取り中', state['stage'])
            self.assertTrue(any('[DETECTED]' in line['text'] for line in state['lines']))
            self.assertEqual(monitor.snapshot(state['next'])['lines'], [])
            self.assertTrue(monitor.snapshot(100000)['lines']) # browser recovers after restart
            monitor.record('[BOOT] Network task running.')
            self.assertIn('ネットワーク接続待ち', monitor.snapshot()['stage'])
            monitor.record('[SERVER] Authenticated HTTPS status check passed.')
            self.assertIn('接続OK', monitor.snapshot()['stage'])
            monitor.record('[VOICE] Preparing streaming call.')
            monitor.record('[SERVER] Authenticated HTTPS status check passed.')
            self.assertEqual(monitor.snapshot()['stage'], 'M5に接続中') # late health response cannot hide a call
            with self.assertRaises(ValueError):
                monitor.send('c') # a chime test cannot be silently bypassed with a manual call
            with self.assertRaises(ValueError):
                monitor.send('q\nc')
            monitor.send('q')
            self.assertTrue(select.select([master], [], [], 1)[0])
            self.assertEqual(os.read(master, 128), b'q')
        finally:
            monitor.close(); os.close(slave); os.close(master)

    def test_validated_hardware_commands(self):
        self.assertEqual(command_for('mirror', {'target':'e'}), '@mirror e')
        self.assertEqual(command_for('angles', {'target':'e','rest':0,'press':17}), '@angles e 0 17')
        for body in [{'target':'c'},{'target':'e\\n1'},{}]:
            with self.assertRaises(ValueError): command_for('mirror',body)
        for body in [{'target':'e','rest':-1,'press':17},{'target':'e','rest':0,'press':181},
                     {'target':'e','rest':True,'press':17},{'target':'x','rest':0,'press':17}]:
            with self.assertRaises(ValueError): command_for('angles',body)
        self.assertEqual(command_for('test', {'target': 'c'}), '@test c')
        self.assertEqual(command_for('test', {'target': 'e'}), '@test e')
        self.assertEqual(command_for('stop_test', {}), '@stop')
        for target in ['c\\n1', 'x', None, True]:
            with self.assertRaises(ValueError):
                command_for('test', {'target':target})
        self.assertEqual(command_for('preview', {'target': 'e', 'position': 'p', 'angle': 145}), '@set e p 145')
        for angle in [-1, 181, 1.5, True, '90\n1']:
            with self.assertRaises(ValueError):
                command_for('preview', {'target': 'c', 'position': 'p', 'angle': angle})
        with self.assertRaises(ValueError):
            command_for('reset', {})
        self.assertEqual(command_for('timing', {'field':'call_delay_ms','value':3000}), '@time d 3000')
        self.assertEqual(command_for('timing', {'field':'call_hold_ms','value':200}), '@time c 200')
        for field,value in [('call_delay_ms',-1),('call_delay_ms',30001),('call_hold_ms',99),('end_hold_ms',2001),('return_ms',3001),('bad',1),('call_delay_ms',True),('call_delay_ms',1.5)]:
            with self.assertRaises(ValueError):
                command_for('timing', {'field':field,'value':value})

    def test_m5_background_logs_and_command_replies(self):
        master, slave = pty.openpty()
        lines = []
        bridge = SerialBridge(os.ttyname(slave), log=lines.append)
        def device():
            assert select.select([master], [], [], 2)[0]
            assert os.read(master,128)==b'@time c 200\n'
            os.write(master,b'[SERVO] CALL returning\r\n[CAL] {"ok":true,"call_hold_ms":200}\n')
        worker = threading.Thread(target=device)
        try:
            os.write(master,b'[SERVO] CALL waiting 3000 ms\r\n')
            deadline=time.monotonic()+2
            while not any('CALL waiting' in line for line in lines) and time.monotonic()<deadline: time.sleep(.01)
            self.assertTrue(any('CALL waiting' in line for line in lines))
            worker.start()
            self.assertEqual(bridge.command('@time c 200')['call_hold_ms'],200)
            worker.join()
            self.assertTrue(any('CALL returning' in x for x in lines))
        finally:
            bridge.stop.set(); bridge.worker.join(timeout=1)
            os.close(bridge.fd); os.close(slave); os.close(master)

    def test_only_local_json_actions_reach_hardware(self):
        bridge = Bridge()
        history = ConversationHistory()
        history.record('[VOICE] Transcript visitor: "荷物を置きました"')
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(bridge, SimpleNamespace(history=history)))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        url = f'http://127.0.0.1:{server.server_port}'
        def post(origin, action, body):
            request = urllib.request.Request(url + '/api/' + action, data=json.dumps(body).encode(),
                headers={'Origin': origin, 'Content-Type': 'application/json'})
            return json.load(urllib.request.urlopen(request))
        try:
            self.assertTrue(json.load(urllib.request.urlopen(url+'/api/state'))['ok'])
            self.assertEqual(bridge.commands, ['@get'])
            self.assertTrue(post(url,'mirror',{'target':'e'})['ok'])
            self.assertEqual(bridge.commands[-1],'@mirror e')
            conversation = json.load(urllib.request.urlopen(url+'/api/conversations'))
            self.assertEqual(conversation['session']['messages'][0]['text'], '荷物を置きました')
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(url+'/api/conversations?after=bad')
            self.assertEqual(caught.exception.code,400)
            self.assertTrue(post(url, 'test', {'target':'c'})['ok'])
            self.assertEqual(bridge.commands[-1], '@test c')
            self.assertTrue(post(url, 'stop_test', {})['ok'])
            self.assertEqual(bridge.commands[-1], '@stop')
            self.assertTrue(post(url, 'begin', {})['active'])
            before = list(bridge.commands)
            for origin, action, body, status in [
                ('https://example.com', 'save', {}, 403),
                (url, 'preview', {'target': 'c', 'position': 'p', 'angle': 999}, 400),
            ]:
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    post(origin, action, body)
                self.assertEqual(caught.exception.code, status)
            self.assertEqual(bridge.commands, before)
            self.assertFalse(post(url, 'save', {})['active'])
        finally:
            server.shutdown(); server.server_close(); worker.join()


if __name__ == '__main__':
    unittest.main()
