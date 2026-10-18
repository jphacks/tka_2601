import json
import os
import pty
import select
import threading
import time
import unittest
import urllib.error
import urllib.request
from types import SimpleNamespace
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
            while not lines and time.monotonic()<deadline: time.sleep(.01)
            self.assertIn('CALL waiting',lines[0])
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
