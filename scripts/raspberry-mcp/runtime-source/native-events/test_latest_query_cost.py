"""No live registry/transport. Measure actual SQLite payload reads on fixtures."""
import ast
from pathlib import Path
import unittest
import test_latest_delivery_receipt as fixture

ROOT = Path(__file__).parent
# Prior public query retained only as the regression oracle, never production.
BASELINE_SQL = 'SELECT d.subscription,d.event,d.state,d.at,b.body,t.event IS NOT NULL AS recorded,t.completed_at,t.sender_duration_ms,t.outcome,t.collection_error FROM dispatch d JOIN subscriptions s ON s.id=d.subscription LEFT JOIN delivery_batches b ON b.subscription=d.subscription AND b.id=d.event LEFT JOIN transport_observations t ON t.subscription=d.subscription AND t.event=d.event WHERE s.owner=? ORDER BY d.at DESC,d.event DESC LIMIT 1'


def selected_query(path):
    tree = ast.parse(path.read_text())
    method = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == 'latest_delivery_receipt')
    for node in ast.walk(method):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'execute' and node.args:
            try: sql = ast.literal_eval(node.args[0])
            except (ValueError, TypeError): continue
            if isinstance(sql, str) and sql.startswith('SELECT d.subscription,d.event,d.state,d.at,b.body,'):
                return sql
    raise AssertionError('latest receipt query not found')


class CostCases(unittest.TestCase):
    def setUp(self):
        self.case = fixture.LatestReceiptTests(); self.case.setUp(); self.addCleanup(self.case.tearDown)
        _, self.dispatch = self.case.batch()
        self.db = self.case.reg.db
        self.old = BASELINE_SQL; self.new = selected_query(ROOT / 'registry.py')

    def historical_rows(self):
        self.db.execute('BEGIN')
        try:
            for index in range(500):
                event = format(index + 1, '064x'); at = self.case.now - 10000 + index
                self.db.execute('INSERT INTO dispatch VALUES(?,?,?,?)', ('fixture_sub', event, 'webhook_accepted', at))
                self.db.execute('INSERT INTO delivery_batches VALUES(?,?,?,?)', (event, 'fixture_sub', 'x' * 2048, at))
            self.db.execute('COMMIT')
        except BaseException:
            self.db.execute('ROLLBACK'); raise

    def test_payload_is_read_once_after_key_selection_with_identical_result(self):
        self.historical_rows(); count = [0]
        def observe(value): count[0] += 1; return value
        self.db.create_function('observe_fixture_blob', 1, observe)
        self.db.execute('ALTER TABLE delivery_batches RENAME TO fixture_batches')
        self.db.execute('CREATE VIEW delivery_batches AS SELECT id,subscription,observe_fixture_blob(body) AS body,at FROM fixture_batches')
        previous = tuple(self.db.execute(self.old, ('fixture_owner',)).fetchone()); old_reads = count[0]
        count[0] = 0
        current = tuple(self.db.execute(self.new, ('fixture_owner',)).fetchone()); new_reads = count[0]
        self.assertEqual(previous, current)
        self.assertGreater(old_reads, 100)
        self.assertEqual(new_reads, 1)
        self.db.execute('PRAGMA query_only=ON'); changes = self.db.total_changes
        result = self.case.reg.latest_delivery_receipt(self.case.now)
        self.assertEqual(result['state'], 'observed'); self.assertTrue(result['batch_membership_verified'])
        self.assertEqual(self.db.total_changes, changes)

    def test_equal_timestamp_tie_break_and_other_owner_match_baseline(self):
        self.db.execute('INSERT INTO subscriptions SELECT ?,?,args,url,secret,old_secret,rotated_at,expires,verified,started,active FROM subscriptions LIMIT 1', ('other_sub', 'other_owner'))
        self.db.execute('INSERT INTO dispatch VALUES(?,?,?,?)', ('other_sub', 'f' * 64, 'uncertain', self.case.now + 100))
        own_at = self.db.execute('SELECT at FROM dispatch WHERE subscription=?', ('fixture_sub',)).fetchone()[0]
        self.db.execute('INSERT INTO dispatch VALUES(?,?,?,?)', ('fixture_sub', 'f' * 64, 'uncertain', own_at))
        for owner in ('fixture_owner', 'other_owner', 'missing_owner'):
            old = self.db.execute(self.old, (owner,)).fetchone(); new = self.db.execute(self.new, (owner,)).fetchone()
            self.assertEqual(None if old is None else tuple(old), None if new is None else tuple(new))
        selected = self.db.execute(self.new, ('fixture_owner',)).fetchone()
        self.assertEqual(selected['subscription'], 'fixture_sub'); self.assertEqual(selected['event'], 'f' * 64)

    def test_query_plan_materializes_key_before_private_batch_join(self):
        rows = [r[-1] for r in self.db.execute('EXPLAIN QUERY PLAN ' + self.new, ('fixture_owner',))]
        self.assertTrue(any('CO-ROUTINE d' in row or 'MATERIALIZE d' in row for row in rows))
        self.assertLess(next(i for i,r in enumerate(rows) if 'SCAN d' in r), next(i for i,r in enumerate(rows) if 'SEARCH b' in r))


if __name__ == '__main__': unittest.main()
