"""Synthetic binding fixtures for separate admission scopes; no live policy."""
import unittest
from test_expired_observation import task_list, test_listing

class SeparateScopeTests(unittest.TestCase):
    def setUp(self):
        self.f=test_listing.ListingTests(); self.f.setUp()
        self.f.store.db.execute('UPDATE tasks SET task_key=? WHERE id=?',('eva-admin-example',test_listing.TASK_A))
        self.f.store.db.execute('UPDATE tasks SET state=? WHERE id=?',('created',test_listing.TASK_B))

    def tearDown(self):self.f.tearDown()

    def collect(self, **kwargs):
        return task_list.collect({'host':'raspberry','page_size':16,'cursor':None},self.f.tasks,self.f.invoke,test_listing.NOW,**kwargs)

    def test_administrative_closure_preserves_workspace_scope(self):
        page=self.collect(administrative_closed=True,legacy_send_closed=False)
        rows={r['thread_id']:r for r in page['threads']}
        self.assertTrue(page['administrative_admission_closed']);self.assertFalse(page['workspace_admission_closed'])
        self.assertEqual(rows[test_listing.A]['send_scope'],'administrative');self.assertEqual(rows[test_listing.A]['adapter_send_admission'],'closed')
        self.assertEqual(rows[test_listing.B]['send_scope'],'workspace');self.assertEqual(rows[test_listing.B]['adapter_send_admission'],'fresh_preflight_required')

    def test_legacy_closed_does_not_close_workspace_or_admin(self):
        page=self.collect(administrative_closed=False,legacy_send_closed=True)
        rows={r['thread_id']:r for r in page['threads']}
        self.assertTrue(page['legacy_reference_send_closed']);self.assertFalse(page['administrative_admission_closed'])
        self.assertTrue(all(r['adapter_send_admission']=='closed' for r in rows.values() if r['send_scope']=='legacy_reference'))
        self.assertEqual(rows[test_listing.A]['adapter_send_admission'],'fresh_preflight_required')

if __name__=='__main__':unittest.main()
