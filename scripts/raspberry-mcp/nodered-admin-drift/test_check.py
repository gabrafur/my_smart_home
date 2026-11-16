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
                                            'backend': {'host': '192.0.2.6'}}).encode(),
            drift.READER_POLICY: json.dumps({'container_id': ID, 'image': 'sha256:img'}).encode(),
            drift.READER: READER}


def run(schemas, live=(ID, 'sha256:img', '/repo/docker-compose.yml', '192.0.2.6'), guard=GUARD):
    data = files(guard)
    return drift.build(read=lambda p: data[p], schema=lambda p: schemas[p], docker=lambda: live, clock=lambda: 0)


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

    def test_docker_failure_is_unknown_not_aligned(self):
        data = files()
        def broken():
            raise OSError('down')
        status = drift.build(read=lambda p: data[p], schema=lambda p: ALIGNED[p], docker=broken, clock=lambda: 0)
        self.assertEqual(status['state'], 'unknown')


if __name__ == '__main__':
    unittest.main()
