import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('drift', Path(__file__).with_name('check.py'))
drift = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drift)

GUARD = b"""SCHEMAS = {
 'task': {'tasks': 'id state', 'audit': 'seq id'},
 'legacy': {'jobs': 'id state'},
}
LEDGERS = {
 'task': '/ledgers/task.sqlite3',
 'legacy': '/ledgers/legacy.sqlite3',
}
"""
ID = 'a' * 64
READER = ("LABELS={'com.docker.compose.project.config_files':'/repo/docker-compose.yml'}\n").encode()


def files(guard=GUARD):
    sha = drift.hashlib.sha256(guard).hexdigest()
    return {drift.GUARD: guard,
            drift.ADMIN_POLICY: json.dumps({'sources': {'native_guard.py': sha},
                                            'native_guard_producer': {'source_sha256': sha},
                                            'backend': {'host': '192.0.2.6'},
                                            'session_cleanup_recovery': {'runtime_source_parent_pins': PINS}}).encode(),
            drift.READER_POLICY: json.dumps({'container_id': ID, 'image': 'sha256:img'}).encode(),
            drift.READER: READER}


PINS = {'/usr/src/a.js': {'/': [61, 10, 0, 0, 493], '/usr': [61, 11, 0, 0, 493]}}


def run(schemas, live=(ID, 'sha256:img', '/repo/docker-compose.yml', '192.0.2.6'), guard=GUARD,
        ancestors=None, sessions=()):
    data = files(guard)
    current = {n: v for value in PINS.values() for n, v in value.items()}
    return drift.build(read=lambda p: data[p], schema=lambda p: schemas[p], docker=lambda: live, clock=lambda: 100000,
                       ancestors=ancestors or (lambda names: current), sessions=lambda: list(sessions))


ALIGNED = {'/ledgers/task.sqlite3': {'tasks': ['id', 'state'], 'audit': ['seq', 'id']},
           '/ledgers/legacy.sqlite3': {'jobs': ['id', 'state']}}


class DriftTests(unittest.TestCase):
    def test_aligned_chain(self):
        status = run(ALIGNED)
        self.assertEqual(status['state'], 'aligned')
        self.assertFalse(status['changes_chain'])

    def test_new_table_and_column_are_drift_with_names_only(self):
        live = json.loads(json.dumps(ALIGNED))
        live['/ledgers/task.sqlite3']['history_refs'] = ['kind', 'id']
        live['/ledgers/legacy.sqlite3']['jobs'].append('created')
        status = run(live)
        self.assertEqual(status['state'], 'drift')
        self.assertEqual(status['checks']['ledger_schemas']['task']['extra_tables'], ['history_refs'])
        self.assertEqual(status['checks']['ledger_schemas']['legacy']['column_changes'], ['jobs'])

    def test_recreated_container_and_moved_address_are_drift(self):
        status = run(ALIGNED, live=('b' * 64, 'sha256:img', '/repo/docker-compose.yml', '192.0.2.4'))
        container = status['checks']['container']
        self.assertEqual((container['container_identity'], container['backend_address']), ('drift', 'drift'))
        self.assertEqual(status['state'], 'drift')

    def test_recreated_container_moves_cleanup_pins(self):
        status = run(ALIGNED, ancestors=lambda names: {n: [110, 9, 0, 0, 493] for n in names})
        self.assertEqual(status['checks']['session_cleanup_pins'], 'drift')
        self.assertEqual(status['state'], 'drift')

    def test_unrevoked_own_session_past_grace_is_drift(self):
        old = ({'security_cleanup_confirmed': False, 'observed_at': 100000 - 3600}, False)
        young = ({'security_cleanup_confirmed': False, 'observed_at': 100000 - 60}, False)
        proven = ({'security_cleanup_confirmed': False, 'observed_at': 100000 - 3600}, True)
        self.assertEqual(run(ALIGNED, sessions=[young, proven])['state'], 'aligned')
        status = run(ALIGNED, sessions=[old, young])
        self.assertEqual(status['checks']['unrevoked_own_sessions'], {'state': 'drift', 'count': 1})

    def test_docker_failure_is_unknown_not_aligned(self):
        data = files()
        def broken():
            raise OSError('down')
        status = drift.build(read=lambda p: data[p], schema=lambda p: ALIGNED[p], docker=broken, clock=lambda: 0)
        self.assertEqual(status['state'], 'unknown')


if __name__ == '__main__':
    unittest.main()
