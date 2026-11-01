import copy
import json
import unittest
import tempfile
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, Mock
import client_event_policy as module
from client_event_policy import APPROVED, project

class ProjectionTests(unittest.TestCase):
    def test_valid_client_approval_is_not_executor_or_schedule_proof(self):
        out = project(copy.deepcopy(APPROVED), identity_verified=True, revoked=False)
        self.assertTrue(out['approval_active'])
        self.assertFalse(out['execution_proven'])
        self.assertFalse(out['server_scheduling_enabled'])
        out['policy']['scopes'].append('backups')
        self.assertNotIn('backups', APPROVED['scopes'])

    def test_unknown_identity_and_revocation_cannot_grant_approval(self):
        for revoked in [None, 'false', 0]:
            self.assertFalse(project(APPROVED, identity_verified=True, revoked=revoked)['approval_active'])
        self.assertFalse(project(APPROVED, identity_verified=False, revoked=False)['approval_active'])
        self.assertFalse(project(APPROVED, identity_verified='true', revoked=False)['approval_active'])
        self.assertEqual(project(APPROVED, identity_verified=True, revoked=True)['state'], 'revoked')

    def test_scope_expansion_and_confirmation_removal_are_refused(self):
        for key, changed in [('scopes',['backups']), ('maximum_items_per_batch',33),
                             ('interface_confirmations_required',False),
                             ('server_scheduling_enabled',True), ('permanent_deletion_allowed',True),
                             ('schema_version',True), ('expires_at',123)]:
            value=copy.deepcopy(APPROVED); value[key]=changed
            self.assertFalse(project(value, identity_verified=True, revoked=False)['approval_active'])

    def test_untrusted_text_and_malformed_input_are_not_exported(self):
        for value in [None, [], {}, {**APPROVED, 'message':'PRIVATE-SYNTHETIC-CONTENT'}]:
            out=project(value, identity_verified=True, revoked=False)
            self.assertFalse(out['approval_active'])
            self.assertNotIn('PRIVATE-SYNTHETIC-CONTENT',json.dumps(out))

    def test_fixed_file_read_refuses_modes_hardlinks_symlinks_and_missing(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'approval.json';p.write_text(json.dumps(APPROVED));p.chmod(0o644)
            marker=Path(temp)/'revoked'
            original=os.fstat
            def root_info(fd):
                s=original(fd)
                return SimpleNamespace(st_mode=s.st_mode,st_uid=0,st_nlink=s.st_nlink,st_size=s.st_size)
            with patch.object(module,'POLICY',p),patch.object(module,'REVOKED',marker),patch.object(module.os,'fstat',side_effect=root_info):
                self.assertTrue(module.observe()['approval_active'])
                p.chmod(0o600);self.assertFalse(module.observe()['approval_active']);p.chmod(0o644)
                link=Path(temp)/'alias';os.link(p,link);self.assertFalse(module.observe()['approval_active']);link.unlink()
                p.rename(link);p.symlink_to(link);self.assertFalse(module.observe()['approval_active']);p.unlink()
                self.assertFalse(module.observe()['approval_active'])

    def test_revocation_and_unsafe_marker_are_not_approval(self):
        marker=Mock();marker.lstat.return_value=SimpleNamespace(st_mode=0o100600,st_uid=0,st_nlink=1)
        with patch.object(module,'REVOKED',marker),patch.object(module,'POLICY') as policy:
            # Marker checks are validated before any policy contents can grant.
            marker.lstat.return_value.st_mode=0o120777
            self.assertFalse(module.observe()['approval_active'])
            policy.__fspath__.assert_not_called()

    def test_runtime_admission_publishes_client_state_without_constructing_engine(self):
        import runtime
        with patch.object(runtime.client_event_policy,'observe',return_value={'state':'approved','execution_proven':False}), \
             patch.object(runtime.maintenance,'policy',return_value={'expires_at':None}), \
             patch.object(runtime,'STATE',Path('/nonexistent-synthetic-storage')), \
             patch.object(runtime,'engine') as engine:
            out=runtime.admission()
            self.assertEqual(out['client_event_policy']['state'],'approved')
            self.assertFalse(out['recurring_execution_enabled'])
            engine.assert_not_called()

if __name__ == '__main__': unittest.main()
