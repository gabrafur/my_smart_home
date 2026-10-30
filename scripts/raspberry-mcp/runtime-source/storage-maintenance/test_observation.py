"""Synthetic metadata fixtures only; no private runtime, Docker or services."""
import datetime
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import observation as o

class ObservationTests(unittest.TestCase):
    def test_legacy_report_rejects_booleans_and_drops_private_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)/'report.json'
            p.write_text(json.dumps({'last_maintenance_at': '2026-01-01T00:00:00Z',
                                    'filesystem_total_bytes': True, 'private_name': 'secret',
                                    'home_assistant_manual_snapshots_logical_bytes': 45}))
            p.chmod(0o600)
            r = o.legacy_report(p, now=1767230000)
            self.assertEqual(r['state'], 'stale')
            self.assertIsNone(r['data']['total_bytes'])
            self.assertEqual(r['data']['logical_bytes_by_category']['snapshots'], 45)
            self.assertNotIn('secret', json.dumps(r))
            self.assertFalse(r['data']['deleted_open_scan_complete'])

    def test_report_symlinks_invalid_clock_and_oversize_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)/'report';p.write_text('{}');link = Path(tmp)/'link';link.symlink_to(p)
            for f in (p, link):
                self.assertEqual(o.legacy_report(f)['state'], 'unknown')
            p.write_bytes(b'x'*16385)
            self.assertIsNone(o.legacy_report(p)['data'])

    def test_metadata_scan_hides_names_does_not_follow_links_or_double_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp);secret = p/'private-name';secret.write_bytes(b'never exported')
            (p/'external-link').symlink_to('/etc')
            import os
            os.link(secret, p/'hardlink')
            row = o.measure((p,), float('inf'), 100, 'logs')
            self.assertTrue(row['complete'])
            self.assertEqual(row['logical_bytes_lower_bound'], len(b'never exported'))
            text = json.dumps(row)
            self.assertNotIn('private-name', text)
            self.assertNotIn('never exported', text)

    def test_budget_exhaustion_is_partial_not_zero_or_complete(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            for n in range(10): (p/str(n)).touch()
            row = o.measure((p,), float('inf'), 2, 'logs')
            self.assertFalse(row['complete'])
            self.assertLessEqual(row['metadata_entries'], 2)
            late = o.measure((p,), 1, 100, 'logs', clock=lambda: 2)
            self.assertFalse(late['complete'])
            self.assertEqual(late['metadata_entries'], 0)

    def test_backup_archives_and_manual_snapshots_are_distinct_protected_groups(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp);(p/'personal.tar').write_bytes(b'archive');(p/'manual.db').write_bytes(b'database')
            (p/'nested').mkdir();(p/'nested/other.tar').write_bytes(b'nested')
            self.assertEqual(o.measure((p,), float('inf'), 100, 'backups')['logical_bytes_lower_bound'], 7)
            self.assertEqual(o.measure((p,), float('inf'), 100, 'snapshots')['logical_bytes_lower_bound'], 8)

    def test_deleted_open_scan_deduplicates_without_names_or_pids(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp);(p/'123/fd').mkdir(parents=True);f=p/'private (deleted)';f.write_bytes(b'abc')
            for n in ['1', '2']: (p/'123/fd'/n).symlink_to(f)
            row = o.deleted_open(float('inf'), p)
            self.assertEqual(row['count_lower_bound'], 1)
            self.assertEqual(row['logical_bytes_lower_bound'], 3)
            self.assertNotIn('private', json.dumps(row))
            self.assertNotIn('123', json.dumps(row))
            self.assertFalse(o.deleted_open(float('inf'), p, maximum=0)['complete'])

if __name__ == '__main__': unittest.main()
