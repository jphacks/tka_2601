import sys
import time
import unittest

from suites import Suites, SuiteBusy


def python(code):
    return [sys.executable, '-c', code]


class SuitesTests(unittest.TestCase):
    def wait(self, suites, seconds=10):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            state = suites.snapshot()
            if not state['running'] and not state['queued']:
                return state
            time.sleep(.02)
        self.fail('a suite did not finish')

    def test_result_and_output_of_each_suite(self):
        suites = Suites({'good': ('good', python('print("done")')), 'bad': ('bad', python('import sys; print("broken"); sys.exit(3)'))})
        suites.start('all')
        state = self.wait(suites)
        self.assertEqual(state['suites']['good']['state'], 'ok')
        self.assertEqual(state['suites']['good']['lines'], ['done'])
        self.assertEqual(state['suites']['bad']['state'], 'failed')
        self.assertEqual(state['suites']['bad']['lines'], ['broken'])
        self.assertIsNotNone(state['suites']['bad']['seconds'])

    def test_a_second_start_is_refused_and_unknown_names_rejected(self):
        suites = Suites({'slow': ('slow', python('import time; time.sleep(30)'))})
        with self.assertRaises(ValueError):
            suites.start('rm -rf')
        suites.start('slow')
        with self.assertRaises(SuiteBusy):
            suites.start('slow')
        while suites.snapshot()['suites']['slow']['state'] != 'running' or suites.process is None:
            time.sleep(.01)
        suites.close()
        self.assertEqual(self.wait(suites)['suites']['slow']['state'], 'stopped')

    def test_stop_clears_the_queue_and_stops_children(self):
        suites = Suites({'first': ('first', python('import subprocess, sys, time; subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"]); time.sleep(30)')),
                         'second': ('second', python('print("must not run")'))})
        suites.start('all')
        time.sleep(.3)
        suites.stop()
        state = self.wait(suites)
        self.assertEqual(state['suites']['first']['state'], 'stopped')
        self.assertEqual(state['suites']['second']['state'], 'idle')
        self.assertEqual(state['suites']['second']['lines'], [])

    def test_a_rerun_replaces_the_previous_result(self):
        suites = Suites({'good': ('good', python('print("done")'))})
        for _ in range(2):
            suites.start('good')
            state = self.wait(suites)
        self.assertEqual(state['suites']['good']['lines'], ['done'])


if __name__ == '__main__':
    unittest.main()
