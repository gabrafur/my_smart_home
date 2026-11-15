"""Synthetic projection tests. No daemon, policies, database, or home data reads."""
import importlib.util
from pathlib import Path
import types
import unittest
from unittest.mock import patch

from test_expired_observation import c as projection, task_list as listing

class ProjectionTests(unittest.TestCase):
    def setUp(self):
        self.policy = {'enabled': True, 'workspace_thread_communication': True, 'expires_at': None}
    def state(self, legacy=None, revoked=False):
        return projection.communication_state(self.policy, legacy or {}, revoked, 1000)
    def test_permanent_peer_failure_is_not_expiry(self):
        self.assertEqual(self.state({'_v2':True, '_v2_peer_unconfirmed':True}), 'closed_peer_unconfirmed')
        self.assertIsNone(self.policy['expires_at'])
    def test_true_expiry_is_reported(self):
        self.policy['expires_at'] = 999
        self.assertEqual(self.state(), 'closed_expired')
    def test_permanent_valid_policy_requires_actual_preflight(self):
        self.assertEqual(self.state({'_v2':True}), 'fresh_preflight_required')
    def test_owner_revocation_remains_distinct(self):
        self.assertEqual(self.state({'_v2_peer_unconfirmed':True}, revoked=True), 'closed_revoked')
    def test_disabled_policy_remains_closed(self):
        self.policy['enabled'] = False
        self.assertEqual(self.state({'_v2_peer_unconfirmed':True}), 'closed_disabled')
    def test_unapproved_communication_is_not_opened(self):
        self.policy['workspace_thread_communication'] = False
        self.assertEqual(self.state(), 'not_approved')
    def test_legacy_boundary_does_not_claim_expiry(self):
        self.assertEqual(self.state({'_observation_only':True}), 'closed_legacy_transport')
    def test_listing_accepts_new_labels_without_dispatch(self):
        with patch.object(listing, 'registry', return_value=([], [], False)):
            for state in ('closed_peer_unconfirmed','closed_legacy_transport','closed_expired','closed_revoked','closed_disabled','not_approved','fresh_preflight_required'):
                result = listing.collect({'host':'raspberry','page_size':1,'cursor':None}, types.SimpleNamespace(), lambda _:self.fail('unexpected daemon read'), now=1000, admission_closed=True, communication_policy={'enabled':True,'expires_at':None,'state':state})
                self.assertEqual(result['workspace_thread_communication']['state'], state)
                self.assertFalse(result['workspace_thread_communication']['admission_active'])
                self.assertEqual(result['assistant_dispatches'],0)

if __name__ == '__main__':
    unittest.main()
