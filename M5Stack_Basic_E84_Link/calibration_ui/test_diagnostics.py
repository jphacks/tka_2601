import json
import threading
import time
import unittest
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer
from diagnostics import CHECKS, Diagnostics, DiagnosticBusy
from server import handler_for


class FakeBridge:
    def __init__(self): self.commands = []
    def command(self, value):
        self.commands.append(value)
        if value == '@get': return {'ok': True, 'saved': {}}
        return {'ok': True, 'diagnostic': 'wifi', 'connected': True, 'ip': '172.20.10.2', 'gateway': '172.20.10.1', 'rssi': -55}


class FakeMonitor:
    def __init__(self):
        self.commands, self.logs = [], []
        self.active = False
        self.replies = {'u': '[DIAG] usb ok=1',
            'n': '[DIAG] wifi {"connected":true,"ip":"172.20.10.3","gateway":"172.20.10.1","rssi":-61}',
            't': '[M5] PONG received.', 'v': '[M5 TCP] OK: authenticated',
            'a': '[DIAG] api_https ok=1', 'w': '[API WSS] OK: READY and PONG'}
    def snapshot(self): return {'voice_active': self.active}
    def record(self, text): self.logs.append(text)
    def exchange(self, command, predicate, timeout):
        self.commands.append(command)
        assert predicate(self.replies[command])
        return [], self.replies[command]


def finished(diagnostics):
    deadline = time.monotonic()+2
    while diagnostics.snapshot()['running'] and time.monotonic()<deadline: time.sleep(.005)
    assert diagnostics.snapshot()['running'] is None
    return diagnostics.snapshot()


class DiagnosticTests(unittest.TestCase):
    def test_http_diagnostics_require_local_origin_and_validate_target(self):
        bridge,monitor=FakeBridge(),FakeMonitor()
        diagnostics=Diagnostics(bridge,monitor)
        server=ThreadingHTTPServer(('127.0.0.1',0),handler_for(bridge,monitor,diagnostics))
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        base=f'http://127.0.0.1:{server.server_port}'
        def post(target,origin):
            request=urllib.request.Request(base+'/api/diagnostics',data=json.dumps({'target':target}).encode(),headers={'Origin':origin,'Content-Type':'application/json'})
            return json.load(urllib.request.urlopen(request))
        try:
            self.assertEqual(len(json.load(urllib.request.urlopen(base+'/api/diagnostics'))['results']),8)
            for target,origin,code in [('m5_usb','https://example.com',403),('c',base,400)]:
                with self.assertRaises(urllib.error.HTTPError) as caught: post(target,origin)
                self.assertEqual(caught.exception.code,code)
            self.assertEqual(bridge.commands,[])
            self.assertTrue(post('m5_usb',base)['ok']);finished(diagnostics)
            result=json.load(urllib.request.urlopen(base+'/api/diagnostics'))
            self.assertEqual(result['results']['m5_usb']['state'],'ok')
            response=urllib.request.urlopen(base+'/diagnostics.js')
            self.assertIn('javascript',response.headers['Content-Type'])
        finally:
            diagnostics.close();server.shutdown();server.server_close();worker.join()

    def test_all_eight_checks_use_only_non_actuating_commands(self):
        bridge, monitor = FakeBridge(), FakeMonitor()
        diagnostics = Diagnostics(bridge, monitor)
        for key in CHECKS:
            diagnostics.start(key)
            result = finished(diagnostics)['results'][key]
            self.assertEqual(result['state'], 'ok', (key,result))
            self.assertIsNotNone(result['checked_at'])
            self.assertIsNotNone(result['duration_ms'])
        self.assertEqual(bridge.commands, ['@get','@net'])
        self.assertEqual(monitor.commands, ['u','n','t','v','a','w'])
        self.assertEqual(diagnostics.snapshot()['revision'], 16)
        with self.assertRaises(ValueError): diagnostics.start('c')

    def test_wifi_association_does_not_claim_packet_round_trip(self):
        self.assertEqual(Diagnostics.wifi_result({'connected':True,'ip':'0.0.0.0'})[0], 'failed')
        self.assertEqual(Diagnostics.wifi_result({'connected':False,'ip':'172.20.10.2'})[0], 'failed')
        state, detail = Diagnostics.wifi_result({'connected':True,'ip':'172.20.10.2','rssi':0,'rssi_valid':False})
        self.assertEqual(state, 'ok')
        self.assertNotIn('0 dBm', detail)
        self.assertIn('UDP/TCP',detail)

    def test_call_and_concurrent_checks_are_blocked_without_sending(self):
        monitor, bridge = FakeMonitor(), FakeBridge()
        diagnostics = Diagnostics(bridge,monitor)
        monitor.active = True
        for key in ['m5_udp','m5_tcp','api_https','api_wss']:
            with self.assertRaises(DiagnosticBusy): diagnostics.start(key)
        self.assertEqual(monitor.commands,[])
        monitor.active = False
        entered, release = threading.Event(), threading.Event()
        def wait(command):
            entered.set(); release.wait(2)
            return {'ok': True,'saved':{}}
        bridge.command = wait
        diagnostics.start('m5_usb'); self.assertTrue(entered.wait(1))
        with self.assertRaises(DiagnosticBusy): diagnostics.start('e84_usb')
        release.set(); finished(diagnostics)

    def test_errors_and_api_partial_readiness_do_not_report_success(self):
        monitor, bridge = FakeMonitor(), FakeBridge()
        diagnostics = Diagnostics(bridge, monitor)
        monitor.replies['v'] = '[M5 TCP] not_accepted'
        diagnostics.start('m5_tcp')
        self.assertEqual(finished(diagnostics)['results']['m5_tcp']['state'], 'blocked')
        def timeout(*args): raise TimeoutError('応答なし')
        monitor.exchange = timeout
        diagnostics.start('api_wss')
        self.assertEqual(finished(diagnostics)['results']['api_wss']['state'], 'failed')
        def partial(*args):
            return [{'text':'[SERVER] /api/status HTTP 200; body (15 bytes): {"ready":false}'}], '[DIAG] api_https ok=1'
        monitor.exchange = partial
        diagnostics.start('api_https')
        self.assertEqual(finished(diagnostics)['results']['api_https']['state'], 'warning')
