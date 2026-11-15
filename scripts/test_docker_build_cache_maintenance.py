"""No Docker or household effects: bounded metadata and dispatch mock tests."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import contextlib
import io
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cache_maintenance', Path(__file__).with_name('docker-build-cache-maintenance.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = 1794078000


def metadata(rid='abcdefghijklmnopqrstuvwxy', size=1000):
    return {'ID': rid, 'Type': 'regular', 'InUse': False, 'Shared': False, 'Size': size,
            'CreatedAt': '2026-08-01T00:00:00Z', 'LastUsedAt': '2026-08-02T00:00:00Z'}


def cli(row):
    return {'ID': row['ID'], 'Type': 'regular', 'Reclaimable': True, 'Shared': False, 'Mutable': False}


def candidate():
    row = metadata()
    return m.select([row], [cli(row)], NOW)


class Eligibility(unittest.TestCase):
    def test_lock_refusal_has_distinct_predispatch_exit_without_running(self):
        with patch('sys.argv', ['cache', '--daily']), patch.object(m, 'locks', side_effect=m.DeferredBeforeDispatch('maintenance_in_progress')), patch.object(m, 'run') as run, contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(m.main(), 75)
            self.assertFalse(json.loads(out.getvalue())['dispatched'])
            run.assert_not_called()

    def test_uncertain_refusal_does_not_use_deferral_exit(self):
        with patch('sys.argv', ['cache', '--daily']), patch.object(m, 'locks', side_effect=m.Refused('existing_dispatch_requires_reconciliation_no_retry')), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(m.main(), 1)

    def test_exact_old_private_record_selected_without_descriptions(self):
        row = metadata(); row['Description'] = 'never export this'
        result = m.select([row], [cli(row)], NOW)
        self.assertEqual(result[0]['bytes'], 1000)
        self.assertNotIn('Description', result[0])

    def test_shared_in_use_wrong_type_mutable_and_new_are_protected(self):
        for field, value in [('Shared', True), ('InUse', True), ('Type', 'frontend'), ('LastUsedAt', '2026-11-07T00:00:00Z'), ('CreatedAt', '2026-11-07T00:00:00Z'), ('Size', -1), ('Size', 2_000_000_001)]:
            row = metadata(); row[field] = value
            self.assertEqual(m.select([row], [cli(row)], NOW), [], field)
        for field, value in [('Mutable', True), ('Reclaimable', False), ('Shared', True)]:
            row = metadata(); other = cli(row); other[field] = value
            self.assertEqual(m.select([row], [other], NOW), [], field)

    def test_unknown_or_humanized_age_is_not_eligible(self):
        for date in [None, '2 months ago', '2026-08-02', 'garbage']:
            row = metadata(); row['LastUsedAt'] = date
            self.assertEqual(m.select([row], [cli(row)], NOW), [])

    def test_count_and_byte_bounds(self):
        rows = [metadata('a' * 20 + str(i), 1000) for i in range(40)]
        self.assertEqual(len(m.select(rows, list(map(cli, rows)), NOW)), 32)
        for row in rows: row['Size'] = 1_100_000_000
        self.assertEqual(len(m.select(rows, list(map(cli, rows)), NOW)), 1)

    def test_record_with_retained_dependent_is_not_dispatched(self):
        parent, child, recent = metadata('p' * 20), metadata('c' * 20), metadata('r' * 20)
        recent['LastUsedAt'] = '2026-11-07T00:00:00Z'
        rows = [parent, child, recent]
        listing = [cli(parent), dict(cli(child), Parents=[parent['ID']]), dict(cli(recent), Parents=[child['ID']])]
        # A recent record depends on the chain: pruning it would remove nothing.
        self.assertEqual(m.select(rows, listing, NOW), [])
        # Without the recent dependent the whole old chain is eligible together.
        self.assertEqual({r['id'] for r in m.select(rows[:2], listing[:2], NOW)}, {parent['ID'], child['ID']})
        with self.assertRaises(m.Refused):
            m.select([parent], [dict(cli(parent), Parents='x')], NOW)

    def test_duplicate_and_malicious_ids_refused(self):
        row = metadata()
        with self.assertRaises(m.Refused): m.select([row, row], [cli(row)], NOW)
        row['ID'] = 'safe|.*'
        self.assertEqual(m.select([row], [cli(row)], NOW), [])
        with self.assertRaises(m.Refused): m.prune_args([{'id': 'safe|.*'}])

    def test_exact_anchored_prune_never_general_cleanup(self):
        args = m.prune_args(candidate())
        self.assertEqual(args[:8], m.DOCKER + ['prune', '--force'])
        self.assertIn('unix:///var/run/docker.sock', args)
        self.assertIn('id~=^(abcdefghijklmnopqrstuvwxy)$', args)
        self.assertIn('until=720h', args)
        for value in ('--all', 'image', 'volume', 'system'): self.assertNotIn(value, args)


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = Path(self.temp.name)
        self.patches = [patch.object(m, 'inventory', return_value=candidate()),
                        patch.object(m, 'resource_check'), patch.object(m, 'available_bytes', side_effect=[100, 1000]),
                        patch.object(m, 'engine_inventory', return_value=[]),
                        patch.object(m.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'', b''))]
        self.mocks = [p.start() for p in self.patches]

    def tearDown(self):
        for p in self.patches: p.stop()
        self.temp.cleanup()

    def test_dry_run_then_single_apply_and_duplicate_block(self):
        preview = m.run('--dry-run', self.state, NOW)
        self.assertEqual(preview['state'], 'dry_run'); self.mocks[-1].assert_not_called()
        result = m.run('--apply', self.state, NOW + 1)
        self.assertEqual(result['state'], 'verified')
        self.assertEqual(result['removed_record_count'], 1)
        self.assertEqual(result['filesystem_net_increase_bytes'], 900)
        self.assertEqual(m.run('--daily', self.state, NOW + 2)['state'], 'daily_cooldown')
        self.mocks[-1].assert_called_once()

    def test_uncertain_result_persisted_and_never_retried(self):
        self.mocks[-1].side_effect = subprocess.TimeoutExpired('docker', 120)
        with self.assertRaises(m.Refused): m.run('--daily', self.state, NOW)
        self.assertEqual(json.loads((self.state / 'latest.json').read_text())['state'], 'uncertain')
        with self.assertRaisesRegex(m.Refused, 'reconciliation'): m.run('--daily', self.state, NOW + 90000)
        self.mocks[-1].assert_called_once()

    def test_changed_inventory_aborts_without_dispatch(self):
        m.run('--dry-run', self.state, NOW)
        self.mocks[0].return_value = []
        with self.assertRaisesRegex(m.Refused, 'candidate_changed'): m.run('--apply', self.state, NOW + 1)
        self.mocks[-1].assert_not_called()

    def test_expired_plan_and_pressure_refused(self):
        m.run('--dry-run', self.state, NOW)
        with self.assertRaisesRegex(m.Refused, 'plan_expired'): m.run('--apply', self.state, NOW + 901)
        self.mocks[1].side_effect = m.Refused('memory_pressure')
        with self.assertRaisesRegex(m.Refused, 'memory_pressure'): m.run('--daily', self.state, NOW)
        self.mocks[-1].assert_not_called()

    def test_shared_lock_blocks_concurrent_worker(self):
        state = self.state / 'state'; lock = self.state / 'maintenance.lock'
        with m.locks(state, lock):
            with self.assertRaisesRegex(m.Refused, 'maintenance_in_progress'):
                with m.locks(state, lock): pass
        self.mocks[-1].assert_not_called()

    def test_bounded_wait_takes_a_turn_after_a_busy_worker_releases(self):
        import threading
        state = self.state / 'state'; lock = self.state / 'maintenance.lock'
        holder = m.locks(self.state / 'other', lock); holder.__enter__()
        threading.Timer(0.4, lambda: holder.__exit__(None, None, None)).start()
        with m.locks(state, lock, wait=3.0): pass
        with m.locks(self.state / 'other', lock):
            started = m.time.monotonic()
            with self.assertRaisesRegex(m.Refused, 'maintenance_in_progress'):
                with m.locks(state, lock, wait=0.5): pass
            self.assertLess(m.time.monotonic() - started, 2.0)

    def test_symlink_state_refused(self):
        link = self.state / 'link'; link.symlink_to(self.state, target_is_directory=True)
        with self.assertRaisesRegex(m.Refused, 'unsafe_state'):
            with m.locks(link, self.state / 'lock'): pass

    def test_no_candidates_does_not_dispatch(self):
        self.mocks[0].return_value = []
        self.assertEqual(m.run('--daily', self.state, NOW)['state'], 'no_candidates')
        self.mocks[-1].assert_not_called()

    def test_timeout_before_dispatch_is_distinct_and_leaves_nothing_to_reconcile(self):
        self.mocks[0].side_effect = subprocess.TimeoutExpired('docker', 15)
        status, result = m.execute('--daily', self.state)
        self.assertEqual((status, result['state'], result['reason'], result['dispatched']),
                         (74, 'refused_before_dispatch', 'TimeoutExpired', False))
        self.mocks[-1].assert_not_called()
        self.assertFalse((self.state / 'latest.json').exists())
        self.assertEqual(m.execute('--reconcile', self.state), (0, {'state': 'no_unresolved_dispatch', 'dispatched': False}))

    def test_pressure_after_a_verified_receipt_is_still_before_dispatch(self):
        m.run('--dry-run', self.state, NOW); m.run('--apply', self.state, NOW + 1)
        self.mocks[1].side_effect = m.Refused('memory_pressure')
        with patch.object(m.time, 'time', return_value=NOW + 90000):
            status, result = m.execute('--daily', self.state)
        self.assertEqual((status, result['reason']), (74, 'memory_pressure'))
        self.assertEqual(m.execute('--reconcile', self.state)[0], 0)
        self.mocks[-1].assert_called_once()

    def test_uncertain_dispatch_requires_reconciliation_and_is_never_released(self):
        self.mocks[-1].side_effect = subprocess.TimeoutExpired('docker', 120)
        status, result = m.execute('--daily', self.state)
        self.assertEqual((status, result['state'], result['receipt_state']), (1, 'refused', 'uncertain'))
        status, result = m.execute('--reconcile', self.state)
        self.assertEqual((status, result['state'], result['receipt_state']), (1, 'unresolved_dispatch', 'uncertain'))
        self.assertEqual(m.execute('--daily', self.state)[0], 1)
        self.mocks[-1].assert_called_once()

    def test_unreadable_receipt_is_unresolved_and_reconcile_never_mutates(self):
        self.state.mkdir(exist_ok=True); (self.state / 'latest.json').write_text('{')
        self.assertEqual(m.execute('--reconcile', self.state)[0], 1)
        self.assertEqual((self.state / 'latest.json').read_text(), '{')
        self.mocks[-1].assert_not_called(); self.mocks[0].assert_not_called()

    def test_reconcile_ignores_busy_daily_workers_but_not_a_running_helper(self):
        lock = self.state / 'maintenance.lock'
        with patch.object(m, 'ROOT', self.state), m.locks(self.state / 'other', lock):
            self.assertEqual(m.execute('--reconcile', self.state)[0], 0)
        with m.locks(self.state, lock):
            self.assertEqual(m.execute('--reconcile', self.state)[0], 75)

    def test_reconcile_defers_under_contention(self):
        def busy(): raise m.DeferredBeforeDispatch('maintenance_in_progress')
        self.assertEqual(m.execute('--reconcile', self.state, lock=busy)[0], 75)


if __name__ == '__main__': unittest.main()
