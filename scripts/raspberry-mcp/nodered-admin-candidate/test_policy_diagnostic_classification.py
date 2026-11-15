"""Pure synthetic policy checks. No native adapters, network or runtime state."""
import ast
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import coordination

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('candidate_engine', HERE / 'engine.py')
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)

TRANSIENT_REASONS = (
    'standing_installation_unconfirmed',
    'combined_installation_unconfirmed',
    'owned_session_cleanup_unconfirmed',
    'session_receipt_missing',
    'session_cleanup_unconfirmed',
)


class Coordination:
    def __init__(self, reason=None):
        self.reason = reason

    def execution_blocker(self):
        return self.reason

    def revoked(self):
        return self.reason is not None


class LegacyCoordination:
    def __init__(self, revoked=False):
        self.closed = revoked

    def revoked(self):
        return self.closed


def policy_engine(coordination):
    result = object.__new__(engine.Engine)
    result.coordination = coordination
    result.clock = lambda: 1000
    result.policy = {
        'enabled': True,
        'host': 'raspberry',
        'project': '/mnt/data/docker',
        'activation_confirmed': True,
        'lease_kind': 'persistent_revocable',
        'standing_maintenance_authorized': True,
        'expires_at': None,
        'maximum_deploys_per_24h': 4,
        'minimum_deploy_spacing_seconds': 60,
        'maximum_plan_age_seconds': 900,
    }
    return result


class DiagnosticClassificationTests(unittest.TestCase):
    def test_transient_blockers_preserve_exact_reason_and_refuse_operation(self):
        for reason in TRANSIENT_REASONS:
            with self.subTest(reason=reason):
                value = policy_engine(Coordination(reason))
                with self.assertRaisesRegex(ValueError, '^' + reason + '$'):
                    value._policy(effect=True)

    def test_owner_revocation_retains_existing_public_reason(self):
        value = policy_engine(Coordination('authority_revocation_record'))
        with self.assertRaisesRegex(ValueError, '^policy_revoked$'):
            value._policy()

    def test_legacy_adapter_remains_fail_closed(self):
        value = policy_engine(LegacyCoordination(revoked=True))
        with self.assertRaisesRegex(ValueError, '^policy_revoked$'):
            value._policy()

    def test_open_current_and_legacy_adapters_keep_policy_digest(self):
        for coordination in (Coordination(), LegacyCoordination()):
            value = policy_engine(coordination)
            self.assertEqual(value._policy(effect=True), engine.digest(value.policy))

    def test_finite_expiry_remains_separate(self):
        value = policy_engine(Coordination())
        value.policy['lease_kind'] = 'finite'
        value.policy['expires_at'] = 999
        with self.assertRaisesRegex(ValueError, '^policy_expired_or_completion_margin$'):
            value._policy()

    def test_standing_scope_requires_explicit_enrollment_and_finite_operations(self):
        value = policy_engine(Coordination())
        self.assertTrue(engine.scope_window(value.policy, 1000))
        self.assertTrue(engine.finite_scope_deadline(value.policy, 1900, 1000))
        self.assertFalse(engine.finite_scope_deadline(value.policy, 1901, 1000))
        for field in ('lease_kind', 'standing_maintenance_authorized'):
            policy = dict(value.policy)
            policy.pop(field)
            self.assertFalse(engine.scope_window(policy, 1000))
        value.policy['expires_at'] = True
        self.assertFalse(engine.scope_window(value.policy, 1000))

    def test_gateway_explicitly_whitelists_only_reviewed_transient_reasons(self):
        # Parse the constant without importing native gateway dependencies.
        module = ast.parse((HERE / 'gateway.py').read_text())
        assignment = next(node for node in module.body if isinstance(node, ast.Assign)
                          and any(isinstance(target, ast.Name)
                                  and target.id == 'COORDINATION_EXECUTION_REASONS'
                                  for target in node.targets))
        actual = ast.literal_eval(assignment.value.args[0])
        self.assertEqual(actual, set(TRANSIENT_REASONS))

    def test_gateway_projects_fixed_reasons_and_withholds_arbitrary_errors(self):
        module = ast.parse((HERE / 'gateway.py').read_text())
        names = {'COORDINATION_EXECUTION_REASONS', 'SAFE_REASONS'}
        selected = [node for node in module.body
                    if isinstance(node, ast.Assign)
                    and any(isinstance(target, ast.Name) and target.id in names
                            for target in node.targets)
                    or isinstance(node, ast.FunctionDef) and node.name == 'safe_reason']
        namespace = {}
        exec(compile(ast.Module(body=selected, type_ignores=[]), 'safe_gateway_projection', 'exec'),
             namespace)
        for reason in TRANSIENT_REASONS:
            self.assertEqual(namespace['safe_reason'](ValueError(reason)), reason)
        self.assertEqual(namespace['safe_reason'](ValueError('policy_revoked')), 'policy_revoked')
        self.assertEqual(namespace['safe_reason'](BlockingIOError()), 'shared_lock_busy')
        for reason in ('token=fixture-secret', 'session_cleanup_unconfirmed secret',
                       'unknown_reason', '/private/fixture'):
            self.assertEqual(namespace['safe_reason'](ValueError(reason)),
                             'nodered_admin_operation_unconfirmed')


class CoordinatorDiagnosticTests(unittest.TestCase):
    def test_local_metadata_distinguishes_cleanup_from_owner_revocation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            sessions = root / 'sessions'
            sessions.mkdir()
            block, revoked = root / 'session-unconfirmed.json', root / 'revoked.json'
            coordinator = object.__new__(coordination.RootCoordinator)
            coordinator._unchanged = lambda: None
            coordinator.current_session = None
            # Sealed ownership is independently tested. These fixtures exercise reasons only.
            with patch.object(coordination, 'SESSIONS', sessions), \
                 patch.object(coordination, 'CLEANUP_BLOCK', block), \
                 patch.object(coordination, 'REVOKED', revoked), \
                 patch.object(coordination, 'sealed_json', lambda path: json.loads(path.read_text())):
                self.assertIsNone(coordinator.execution_blocker())
                self.assertFalse(coordinator.revoked())
                block.write_text(json.dumps({'source': 'own_nodered_admin_session_cleanup'}))
                self.assertEqual(coordinator.execution_blocker(), 'owned_session_cleanup_unconfirmed')
                self.assertTrue(coordinator.revoked())
                block.unlink()
                session_id = 'a' * 32
                (sessions / (session_id + '.intent.json')).write_text('{}')
                self.assertEqual(coordinator.execution_blocker(), 'session_receipt_missing')
                receipt = sessions / (session_id + '.receipt.json')
                receipt.write_text(json.dumps({'security_cleanup_confirmed': False}))
                self.assertEqual(coordinator.execution_blocker(), 'session_cleanup_unconfirmed')
                receipt.write_text(json.dumps({'security_cleanup_confirmed': True}))
                self.assertIsNone(coordinator.execution_blocker())
                revoked.write_text(json.dumps({'source': 'own_nodered_admin_revocation',
                                               'operation_id': 'b' * 32}))
                self.assertEqual(coordinator.execution_blocker(), 'authority_revocation_record')
                self.assertTrue(coordinator.revoked())


if __name__ == '__main__':
    unittest.main()
