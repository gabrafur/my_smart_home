import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('observer', Path(__file__).with_name('observer.py'))
o = importlib.util.module_from_spec(spec)
spec.loader.exec_module(o)


class ObserverTests(unittest.TestCase):
    def docker(self, **changes):
        row = {'Type': 'container', 'Action': 'health_status: unhealthy',
            'timeNano': int(1000 * 1e9), 'Actor': {'ID': 'opaque', 'Attributes': {
                'com.docker.compose.project': 'docker', 'com.docker.compose.service': 'nodered',
                'name': 'withheld', 'private': 'withheld'}}}
        row.update(changes)
        return row

    def journal(self, **changes):
        row = {'UNIT': 'raspberry-procmon.service',
            'MESSAGE_ID': 'be02cf6855d2428ba40df7e9d022f03d',
            '__REALTIME_TIMESTAMP': str(int(1000 * 1e6)), '__CURSOR': 'opaque',
            'MESSAGE': 'withheld', 'PRIVATE': 'withheld'}
        row.update(changes)
        return row

    def test_docker_projection_and_stable_deduplication(self):
        row = o.docker_event(self.docker(), 1000.1)
        self.assertEqual(row['service'], 'nodered')
        self.assertEqual(row['action'], 'health_status: unhealthy')
        self.assertAlmostEqual(row['source_to_observer_ms'], 100, places=3)
        self.assertNotIn('withheld', json.dumps(row))
        self.assertEqual(row['id'], o.docker_event(self.docker(), 1000.2)['id'])

    def test_other_projects_services_actions_and_types_are_ignored(self):
        for field, value in [('com.docker.compose.project', 'other'),
                             ('com.docker.compose.service', 'private')]:
            row = self.docker(); row['Actor']['Attributes'][field] = value
            self.assertIsNone(o.docker_event(row, 1000))
        for row in [self.docker(Type='network'), self.docker(Action='exec_start'), {}, None]:
            self.assertIsNone(o.docker_event(row, 1000))

    def test_missing_or_conflicting_source_times_do_not_measure_success(self):
        for value in [None, True, '1000', -1]:
            self.assertIsNone(o.docker_event(self.docker(timeNano=value), 1000))
        for now in [900, 1100]:
            with self.assertRaises(ValueError):
                o.docker_event(self.docker(), now)
            with self.assertRaises(ValueError):
                o.journal_event(self.journal(), now)

    def test_journal_reads_projected_unit_metadata_not_messages(self):
        row = o.journal_event(self.journal(), 1000.2)
        self.assertEqual(row['service'], 'procmon')
        self.assertEqual(row['action'], 'failed')
        self.assertNotIn('withheld', json.dumps(row))
        self.assertNotIn('opaque', json.dumps(row))
        self.assertIsNone(o.journal_event(self.journal(UNIT='other.service'), 1000))
        self.assertIsNone(o.journal_event(self.journal(MESSAGE_ID='unknown'), 1000))

    def test_initial_state_and_channel_failure_remain_unknown(self):
        state = o.State()
        self.assertEqual(state.sequence, 0)
        self.assertEqual(len(state.events), 0)
        self.assertTrue(all(x['state'] == 'unknown' for x in state.sources.values()))
        state.health('docker', 'unknown', 'stream_unavailable_or_invalid')
        self.assertEqual(state.sequence, 0)

    def test_event_ring_is_bounded_and_eviction_is_explicit(self):
        state = o.State()
        row = o.docker_event(self.docker(), 1000)
        state.add(row); state.add(row)
        self.assertEqual(state.sequence, 1)
        for index in range(80):
            state.add({**row, 'id': str(index)})
        self.assertEqual(len(state.events), 64)
        self.assertEqual(state.dropped, 17)
        self.assertEqual(state.sequence, 81)

    def test_failed_resource_read_does_not_become_zero_or_kill_event_collection(self):
        with patch.object(o.Path, 'read_text', side_effect=PermissionError()):
            row, ticks = o.resource_sample()
        self.assertIsNone(ticks)
        self.assertIsNone(row['data']['memory_available_bytes'])
        self.assertIsNone(row['data']['cpu_busy_percent'])
        self.assertIn('memory_available_bytes', row['collection_errors'])


if __name__ == '__main__':
    unittest.main()
