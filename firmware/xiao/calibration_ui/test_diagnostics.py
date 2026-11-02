import json
import threading
import time
import unittest
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer
from diagnostics import CHECKS, Diagnostics, DiagnosticBusy
from server import handler_for


class FakeLink:
    def __init__(self):
        self.commands, self.exchanges, self.logs = [], [], []
        self.active = False
        self.replies = {'u': '[DIAG] usb ok=1',
            'n': '[DIAG] wifi {"connected":true,"ip":"172.20.10.3","gateway":"172.20.10.1","rssi":-61}',
            'a': '[DIAG] api_https ok=1', 'w': '[API WSS] OK: READY and PONG',
            't': '[DIAG] speaker ok=1', 'l': '[DIAG] loopback ok=1'}
    def command(self, value):
        self.commands.append(value)
        return {'ok': True, 'saved': {}}
    def snapshot(self): return {'voice_active': self.active}
    def record(self, text): self.logs.append(text)
    def exchange(self, command, predicate, timeout):
        self.exchanges.append(command)
        assert predicate(self.replies[command])
        return [], self.replies[command]


def finished(diagnostics):
    deadline = time.monotonic()+2
    while diagnostics.snapshot()['running'] and time.monotonic()<deadline: time.sleep(.005)
    assert diagnostics.snapshot()['running'] is None
    return diagnostics.snapshot()


class DiagnosticTests(unittest.TestCase):
    def test_http_diagnostics_require_local_origin_and_validate_target(self):
        link=FakeLink()
        diagnostics=Diagnostics(link)
        server=ThreadingHTTPServer(('127.0.0.1',0),handler_for(link,diagnostics))
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        base=f'http://127.0.0.1:{server.server_port}'
        def post(target,origin):
            request=urllib.request.Request(base+'/api/diagnostics',data=json.dumps({'target':target}).encode(),headers={'Origin':origin,'Content-Type':'application/json'})
            return json.load(urllib.request.urlopen(request))
        try:
            self.assertEqual(len(json.load(urllib.request.urlopen(base+'/api/diagnostics'))['results']),6)
            for target,origin,code in [('usb','https://example.com',403),('c',base,400)]:
                with self.assertRaises(urllib.error.HTTPError) as caught: post(target,origin)
                self.assertEqual(caught.exception.code,code)
            self.assertEqual(link.commands+link.exchanges,[])
            self.assertTrue(post('usb',base)['ok']);finished(diagnostics)
            result=json.load(urllib.request.urlopen(base+'/api/diagnostics'))
            self.assertEqual(result['results']['usb']['state'],'ok')
            response=urllib.request.urlopen(base+'/diagnostics.js')
            self.assertIn('javascript',response.headers['Content-Type'])
        finally:
            diagnostics.close();server.shutdown();server.server_close();worker.join()

    def test_all_checks_use_only_non_actuating_commands(self):
        self.assertEqual(list(CHECKS), ['usb','wifi','api_https','api_wss','speaker','loopback'])
        link = FakeLink()
        diagnostics = Diagnostics(link)
        for key in CHECKS:
            diagnostics.start(key)
            result = finished(diagnostics)['results'][key]
            self.assertEqual(result['state'], 'ok', (key,result))
            self.assertIsNotNone(result['checked_at'])
            self.assertIsNotNone(result['duration_ms'])
        self.assertEqual(link.commands, ['@get'])
        self.assertEqual(link.exchanges, ['u','n','a','w','t','l'])
        self.assertEqual(diagnostics.snapshot()['revision'], 12)
        with self.assertRaises(ValueError): diagnostics.start('c')

    def test_usb_requires_diagnostic_reply_and_settings_readback(self):
        link = FakeLink()
        diagnostics = Diagnostics(link)
        link.replies['u'] = '[DIAG] usb ok=0'
        diagnostics.start('usb')
        self.assertEqual(finished(diagnostics)['results']['usb']['state'], 'failed')
        self.assertEqual(link.commands, [])
        link.replies['u'] = '[DIAG] usb ok=1'
        link.command = lambda value: {'ok': True}
        diagnostics.start('usb')
        self.assertEqual(finished(diagnostics)['results']['usb']['state'], 'failed')

    def test_wifi_association_does_not_claim_packet_round_trip(self):
        self.assertEqual(Diagnostics.wifi_result({'connected':True,'ip':'0.0.0.0'})[0], 'failed')
        self.assertEqual(Diagnostics.wifi_result({'connected':False,'ip':'172.20.10.2'})[0], 'failed')
        state, detail = Diagnostics.wifi_result({'connected':True,'ip':'172.20.10.2','rssi':0,'rssi_valid':False})
        self.assertEqual(state, 'ok')
        self.assertNotIn('0 dBm', detail)
        self.assertIn('HTTPS',detail)

    def test_call_and_concurrent_checks_are_blocked_without_sending(self):
        link = FakeLink()
        diagnostics = Diagnostics(link)
        link.active = True
        for key in ['api_https','api_wss','speaker','loopback']:
            with self.assertRaises(DiagnosticBusy): diagnostics.start(key)
        self.assertEqual(link.exchanges,[])
        link.active = False
        entered, release = threading.Event(), threading.Event()
        def wait(command):
            entered.set(); release.wait(2)
            return {'ok': True,'saved':{}}
        link.command = wait
        diagnostics.start('usb'); self.assertTrue(entered.wait(1))
        with self.assertRaises(DiagnosticBusy): diagnostics.start('wifi')
        release.set(); finished(diagnostics)

    def test_speaker_and_loopback_wait_for_the_final_result(self):
        link = FakeLink()
        diagnostics = Diagnostics(link)
        captured = {}
        real = link.exchange
        def exchange(command, predicate, timeout):
            captured[command] = predicate
            return real(command, predicate, timeout)
        link.exchange = exchange
        for key, command, final in (('speaker','t','speaker'), ('loopback','l','loopback')):
            for state, reply in (('ok', f'[DIAG] {final} ok=1'), ('blocked', f'[DIAG] {final} busy'),
                                 ('failed', f'[DIAG] {final} ok=0 dac_write_failed')):
                link.replies[command] = reply
                diagnostics.start(key)
                result = finished(diagnostics)['results'][key]
                self.assertEqual(result['state'], state, reply)
                if state == 'failed':
                    self.assertIn('dac_write_failed', result['detail'])
        self.assertFalse(captured['t']('[DIAG] speaker playing'))
        self.assertTrue(captured['t']('[DIAG] speaker busy'))
        self.assertFalse(captured['l']('[DIAG] loopback recording'))
        self.assertFalse(captured['l']('[DIAG] loopback playing'))
        self.assertTrue(captured['l']('[DIAG] loopback ok=0 x'))
        self.assertFalse(captured['l']('[DIAG] speaker ok=1'))

    def test_errors_and_api_partial_readiness_do_not_report_success(self):
        link = FakeLink()
        diagnostics = Diagnostics(link)
        for reply in ('[DIAG] api_https busy', '[DIAG] api_https already_running'):
            link.replies['a'] = reply
            diagnostics.start('api_https')
            self.assertEqual(finished(diagnostics)['results']['api_https']['state'], 'blocked')
        for reply in ('[DIAG] api_https network_not_ready', '[DIAG] api_https ok=0'):
            link.replies['a'] = reply
            diagnostics.start('api_https')
            self.assertEqual(finished(diagnostics)['results']['api_https']['state'], 'failed')
        link.replies['w'] = '[API WSS] busy'
        diagnostics.start('api_wss')
        self.assertEqual(finished(diagnostics)['results']['api_wss']['state'], 'blocked')
        link.replies['w'] = '[API WSS] pong_missing'
        diagnostics.start('api_wss')
        self.assertEqual(finished(diagnostics)['results']['api_wss']['state'], 'failed')
        def timeout(*args): raise TimeoutError('応答なし')
        link.exchange = timeout
        diagnostics.start('api_wss')
        self.assertEqual(finished(diagnostics)['results']['api_wss']['state'], 'failed')
        def partial(*args):
            return [{'text':'[SERVER] /api/status HTTP 200; body (15 bytes): {"ready":false}'}], '[DIAG] api_https ok=1'
        link.exchange = partial
        diagnostics.start('api_https')
        self.assertEqual(finished(diagnostics)['results']['api_https']['state'], 'warning')
