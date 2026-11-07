"""Fictional collector only. Never reads /proc, starts a service or emits notices."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location('alarm_candidate', ROOT.parent / 'runtime-source/procmon-observability/observed_collector.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Cases(unittest.TestCase):
    def run_main(self, fail=None, limits_fail=None, emit_fail=None):
        trace = []
        alarm = lambda n: trace.append(('alarm', n))
        mod = SimpleNamespace(signal=SimpleNamespace(alarm=alarm), run_once=Mock(side_effect=fail))
        observer = Mock()
        observer.emit.side_effect = emit_fail
        def limits(module):
            alarm(15)
            if limits_fail:
                raise limits_fail
        with patch.object(m, 'Observer', return_value=observer), patch.object(m, 'load_collector', return_value=mod), patch.object(m, 'apply_observed_limits', side_effect=limits), patch.object(m.os, 'geteuid', return_value=1001), patch.object(m.sys, 'argv', ['fixed']):
            if emit_fail:
                with self.assertRaises(type(emit_fail)):
                    m.main()
                result = None
            else:
                result = m.main()
        return result, trace, mod, observer

    def test_success_disarms_before_telemetry(self):
        result, trace, mod, observer = self.run_main()
        self.assertEqual(result, 0)
        self.assertEqual(trace, [('alarm', 15), ('alarm', 0)])
        mod.run_once.assert_called_once_with()
        observer.emit.assert_called_once_with()

    def test_failed_collection_keeps_failure_and_disarms(self):
        error = TimeoutError('collection_interrupted')
        result, trace, mod, observer = self.run_main(fail=error)
        self.assertEqual(result, 1)
        self.assertEqual(trace[-1], ('alarm', 0))
        observer.emit.assert_called_once_with(error)
        mod.run_once.assert_called_once_with()

    def test_partial_limit_setup_disarms_without_collection(self):
        error = OSError('fictional_setup_failure')
        result, trace, mod, observer = self.run_main(limits_fail=error)
        self.assertEqual(result, 1)
        self.assertEqual(trace, [('alarm', 15), ('alarm', 0)])
        mod.run_once.assert_not_called()
        observer.emit.assert_called_once_with(error)

    def test_telemetry_failure_does_not_leave_deadline_armed(self):
        _, trace, mod, _ = self.run_main(emit_fail=OSError('fictional_output_failure'))
        self.assertEqual(trace[-1], ('alarm', 0))
        mod.run_once.assert_called_once_with()

    def test_budget_remains_armed_during_collect_and_disarmed_before_emit(self):
        trace = []
        mod = SimpleNamespace(signal=SimpleNamespace(alarm=lambda value: trace.append(value)))
        def collect():
            self.assertEqual(trace, [15])
            trace.append('collect')
        mod.run_once = collect
        observer = Mock()
        observer.emit.side_effect = lambda: self.assertEqual(trace, [15, 'collect', 0])
        with patch.object(m, 'Observer', return_value=observer), patch.object(m, 'load_collector', return_value=mod), patch.object(m, 'apply_observed_limits', side_effect=lambda value: value.signal.alarm(15)), patch.object(m.os, 'geteuid', return_value=1001), patch.object(m.sys, 'argv', ['fixed']):
            self.assertEqual(m.main(), 0)

    def test_unloaded_or_refused_entry_does_not_disarm_process_alarm(self):
        for uid, args in [(0, ['fixed']), (1001, ['fixed', 'extra'])]:
            with patch.object(m, 'Observer'), patch.object(m, 'load_collector') as load, patch.object(m.os, 'geteuid', return_value=uid), patch.object(m.sys, 'argv', args):
                self.assertEqual(m.main(), 1)
                load.assert_not_called()

    def test_real_kernel_timer_is_gone_after_fictional_collection(self):
        # The child imports code only and runs a fake collector, then waits
        # beyond its timer. Telemetry/shutdown must have no pending SIGALRM.
        child = r'''
import importlib.util, signal, sys, time, types
from unittest.mock import Mock
s=importlib.util.spec_from_file_location('candidate',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
mod=types.SimpleNamespace(signal=signal,run_once=lambda:None)
m.load_collector=lambda:mod;m.Observer=Mock
def arm(mod):
 signal.signal(signal.SIGALRM,signal.SIG_DFL)
 signal.setitimer(signal.ITIMER_REAL,0.1)
m.apply_observed_limits=arm
sys.argv=['fixed']
assert m.main()==0
remaining=signal.getitimer(signal.ITIMER_REAL)[0]
time.sleep(0.2)
assert remaining==0
'''
        for name, expected in [('observed_collector.py', 0)]:
            result = subprocess.run([sys.executable, '-I', '-S', '-B', '-c', child, str(ROOT.parent / 'runtime-source/procmon-observability' / name)], capture_output=True, timeout=3)
            self.assertEqual(result.returncode, expected, name)


if __name__ == '__main__':
    unittest.main()
