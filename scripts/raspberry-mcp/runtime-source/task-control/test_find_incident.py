from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import sqlite3
import unittest

from task_list import find_incident
from task_store import INCIDENT_PREFIX


class FindIncidentTest(unittest.TestCase):
    object_id = 'a' * 64
    revision = 'b' * 64
    thread = '11111111-2222-3333-4444-555555555555'

    def setUp(self):
        self.folder = TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.path = Path(self.folder.name) / 'jobs.sqlite3'
        self.tasks = SimpleNamespace(STATE=self.path.parent, read=lambda path, *_: path.read_bytes())
        with sqlite3.connect(self.path) as db:
            db.executescript("""
                CREATE TABLE tasks(id TEXT PRIMARY KEY, thread TEXT);
                CREATE TABLE sends(id TEXT PRIMARY KEY, task TEXT, state TEXT, result TEXT);
                CREATE TABLE audit(seq INTEGER PRIMARY KEY, id TEXT, state TEXT);
            """)

    def find(self, object_id=None, revision=None):
        before = self.path.read_bytes()
        result = find_incident({'object_id': object_id or self.object_id,
                                'revision': revision or self.revision}, self.tasks)
        self.assertEqual(before, self.path.read_bytes())
        self.assertFalse(result['new_task_authorized'])
        return result

    def insert_task(self):
        with sqlite3.connect(self.path) as db:
            db.execute('INSERT INTO tasks VALUES (?,?)', (self.object_id[:32], self.thread))

    def insert_binding(self, revision):
        with sqlite3.connect(self.path) as db:
            db.execute('INSERT INTO sends VALUES (?,?,?,?)',
                       (revision[-32:], self.object_id[:32], 'completed', None))
            db.execute('INSERT INTO audit(id,state) VALUES (?,?)',
                       (revision[-32:], INCIDENT_PREFIX + self.object_id + ':' + revision))

    def test_absence_requires_a_readable_registry(self):
        self.assertEqual(self.find()['state'], 'absent')
        with sqlite3.connect(self.path) as db:
            db.execute('DROP TABLE sends')
        with self.assertRaises(sqlite3.OperationalError):
            self.find()

    def test_unlinked_creation_is_unknown_even_with_matching_prefix(self):
        self.insert_task()
        result = self.find()
        self.assertEqual(result['state'], 'unknown')
        self.assertIsNone(result['thread_id'])

    def test_matches_a_middle_revision_without_disclosing_prefix_collision(self):
        self.insert_task()
        for revision in ('c' * 64, self.revision, 'd' * 64):
            self.insert_binding(revision)
        result = self.find()
        self.assertEqual((result['state'], result['thread_id'], result['operation_id']),
                         ('found', self.thread, self.revision[-32:]))
        self.assertEqual(self.find(revision='e' * 64)['state'], 'related')
        self.assertEqual(self.find(revision='e' * 32 + self.revision[-32:])['state'], 'related')
        collision = self.find(object_id=self.object_id[:32] + 'e' * 32)
        self.assertEqual(collision['state'], 'absent')
        self.assertIsNone(collision['thread_id'])

    def test_refuses_orphaned_binding(self):
        self.insert_binding(self.revision)
        with self.assertRaisesRegex(ValueError, 'incident_binding_conflict'):
            self.find()
