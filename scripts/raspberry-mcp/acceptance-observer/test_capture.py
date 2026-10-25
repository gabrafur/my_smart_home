import importlib.util
import json
from pathlib import Path
import types
import tempfile
import stat
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('_fixed_acceptance_capture', Path(__file__).with_name('capture.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
spec = importlib.util.spec_from_file_location('_fixed_acceptance_cadence', Path(__file__).with_name('cadence_window.py'))
cadence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cadence)


class CaptureTests(unittest.TestCase):
    def runtime(self):
        return {'observed_span_seconds': 86401, 'distinct_boot_count': 1,
            'nonmonotonic_pairs': 0, 'invalid_telemetry_rows': 0,
            'journal_limit_reached': False, 'journal_exit': 0}

    def test_elapsed_time_alone_cannot_accept(self):
        result = c.combine({'cadence_24h_proven': False}, self.runtime())
        self.assertFalse(result['cadence_and_emitted_runtime_window_proven'])
        self.assertFalse(result['full_goal_accepted'])

    def test_window_short_of_24h_fails(self):
        value = self.runtime();value['observed_span_seconds'] = 86399.999
        self.assertFalse(c.combine({'cadence_24h_proven': True}, value)['emitted_runtime_24h_window_proven'])

    def test_boot_errors_truncation_and_nonmonotonic_fail(self):
        for change in [{'distinct_boot_count': 2}, {'invalid_telemetry_rows': 1},
                {'journal_limit_reached': True}, {'nonmonotonic_pairs': 1}, {'journal_exit': 1}]:
            value = self.runtime();value.update(change)
            self.assertFalse(c.combine({'cadence_24h_proven': True}, value)['cadence_and_emitted_runtime_window_proven'])

    def test_partial_acceptance_preserves_unproven_scope(self):
        result = c.combine({'cadence_24h_proven': True}, self.runtime())
        self.assertTrue(result['cadence_and_emitted_runtime_window_proven'])
        for key in ['PC_off_proven', 'all_event_latency_proven', 'missing_or_killed_invocation_cost_proven', 'full_goal_accepted']:
            self.assertFalse(result[key])

    def command(self, stdout=b'', returncode=0):
        return types.SimpleNamespace(stdout=stdout, stderr=b'', returncode=returncode)

    def test_journal_uses_fixed_unit_filter_and_bounds(self):
        with patch.object(c.subprocess, 'run', return_value=self.command()) as run:
            value = c.runtime_audit(lambda rows, seconds: {key: 0 for key in c.RUNTIME_KEYS}, 100000)
        args = run.call_args.args[0]
        self.assertIn('--unit=raspberry-procmon.service', args)
        self.assertIn('--lines=2048', args)
        self.assertTrue(any(arg.startswith('--grep=') for arg in args))
        self.assertFalse(value['raw_messages_exported'])

    def test_collection_failure_and_missing_boot_refused(self):
        for command in [self.command(returncode=1), self.command(b'x' * 2097153),
                self.command(json.dumps({'MESSAGE': '{}'}).encode())]:
            with patch.object(c.subprocess, 'run', return_value=command):
                with self.assertRaises(ValueError):
                    c.runtime_audit(lambda *args: {}, 100000)

    def test_journal_reverse_order_does_not_hide_telemetry_regression(self):
        # Native order increases while the recorded telemetry clock regresses.
        rows = [{'MESSAGE': json.dumps({'monotonic_ms': value}), '_BOOT_ID': 'a'*32,
            '__MONOTONIC_TIMESTAMP': str(native)} for native, value in [(200, 10), (100, 20)]]
        seen = []
        def summarize(values, seconds):
            seen.extend(values)
            return {key: 0 for key in c.RUNTIME_KEYS}
        with patch.object(c.subprocess, 'run', return_value=self.command(b'\n'.join(json.dumps(row).encode() for row in rows))):
            c.runtime_audit(summarize, 100000)
        self.assertEqual([row['monotonic_ms'] for row in seen], [20, 10])

    def test_journal_integrity_warning_cannot_accept(self):
        value = self.runtime();value['journal_diagnostic_category'] = 'journal_integrity_warning'
        self.assertFalse(c.combine({'cadence_24h_proven': True}, value)['emitted_runtime_24h_window_proven'])

    def samples(self):
        now = cadence.CANDIDATE_START + 200000
        rows = [{'at': at, 'mono': at, 'boot': 'a'*16, 'error': False,
            'coverage': {key: (1 if key in ('enumerated', 'records') else 0) for key in cadence.COUNTERS}}
            for at in range(now-86400, now, 56)]
        return now, rows

    def test_history_full_window_and_preserved_112_second_gap(self):
        now, rows = self.samples()
        health = {'status': 'completed', 'observed_at': now}
        self.assertTrue(cadence.assess(rows, now, health)['cadence_24h_proven'])
        rows.pop(100)
        value = cadence.assess(rows, now, health)
        self.assertFalse(value['cadence_24h_proven'])
        self.assertEqual(value['max_sample_gap_seconds'], 112)
        self.assertIn('sampling_gap_over_60s', value['issues'])

    def test_clock_change_collection_error_and_stale_health_fail(self):
        for change in ['clock', 'error', 'stale']:
            now, rows = self.samples();health = {'status': 'completed', 'observed_at': now}
            if change == 'clock':
                rows[100]['mono'] -= 3
            elif change == 'error':
                rows[100]['error'] = True
            else:
                health['observed_at'] -= 61
            self.assertFalse(cadence.assess(rows, now, health)['cadence_24h_proven'])

    def test_window_is_immutable_and_stale_temporary_file_cannot_block_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'.window-0430.json.new').write_text('interrupted earlier writer')
            info = types.SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o755)
            with patch.object(c, 'STATE', root), patch.object(c.os, 'fstat', return_value=info):
                c.atomic('window-0430.json', b'first durable report')
                with self.assertRaises(FileExistsError):
                    c.atomic('window-0430.json', b'cannot replace report')
                c.atomic('latest.json', b'old', replace=True)
                c.atomic('latest.json', b'new', replace=True)
            self.assertEqual((root/'window-0430.json').read_bytes(), b'first durable report')
            self.assertEqual((root/'latest.json').read_bytes(), b'new')


class CorrelationReaderTests(unittest.TestCase):
    def info(self, **change):
        value=dict(st_uid=0,st_mode=stat.S_IFREG|0o644,st_nlink=1,st_size=100)
        value.update(change)
        return types.SimpleNamespace(**value)

    def test_fixed_readonly_helper_calls_only_audit_with_same_observation_time(self):
        from unittest.mock import Mock
        module=types.SimpleNamespace(audit=Mock(return_value={'state':'partial'}))
        spec=types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=Mock()))
        with patch.object(Path,'lstat',return_value=self.info()), patch.object(Path,'is_symlink',return_value=False), \
             patch.object(c.importlib.util,'spec_from_file_location',return_value=spec)as location, \
             patch.object(c.importlib.util,'module_from_spec',return_value=module):
            self.assertEqual(c.invocation_correlation(100000),{'state':'partial'})
        self.assertEqual(str(location.call_args.args[1]),'/usr/local/lib/raspberry-procmon-observability/invocation_audit.py')
        module.audit.assert_called_once_with(100000)

    def test_wrong_owner_mode_link_or_size_cannot_load_code(self):
        for change in [{'st_uid':1001},{'st_mode':stat.S_IFREG|0o666},{'st_nlink':2},{'st_size':65537}]:
            with patch.object(Path,'lstat',return_value=self.info(**change)), \
                 patch.object(c.importlib.util,'spec_from_file_location')as location:
                with self.assertRaises(ValueError):c.invocation_correlation(100000)
                location.assert_not_called()


if __name__ == '__main__':
    unittest.main()
