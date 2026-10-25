"""Compose existing routing; no service control, new credential or root RPC."""
import importlib.util
import sys

sys.path.insert(0, '/usr/local/lib/raspberry-repair-control')
sys.path.insert(0, '/usr/local/lib/raspberry-task-control')
sys.path.insert(0, '/usr/local/lib/raspberry-mcp')
import operations
import maintenance_diagnostics as diagnostics
import codex_control as old
import task_control as tasks
import repair_control as repairs
import health_summary as health

spec = importlib.util.spec_from_file_location('existing_task_broker',
    '/usr/local/lib/raspberry-task-control/task-broker.py')
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)


class Broker(legacy.Broker):
    def handle(self, name, args):
        if name in repairs.TOOLS:
            return repairs.handle(name, args, old, tasks)
        if name == 'backup_results':
            if args != {'host': 'raspberry'}:
                raise ValueError('invalid_parameters')
            return health.backups()
        result = super().handle(name, args)
        if name == 'maintenance_capabilities':
            result = health.static_capabilities(result)
            data = result['evidence']['data']
            data['tool_names'] = list(dict.fromkeys([*data['tool_names'], *repairs.TOOLS]))
            data['listed_tool_count'] = len(data['tool_names'])
            data['fixed_repair_catalogue'] = repairs.handle('codex_repair_capabilities',
                                                         {'host': 'raspberry'}, old, tasks)
            task_policy, temporal = tasks.policy(old, observation=True)
            delegation = task_policy.get('admin_delegation')
            data['administrative_delegation'] = {
                'configured': delegation == tasks.ADMIN_DELEGATION,
                'admission_active': delegation == tasks.ADMIN_DELEGATION and task_policy['enabled']
                    and not temporal.get('_observation_only') and not (tasks.STATE/'revoked').exists(),
                'observation_preserved_after_expiry': True,
                'task_key_prefix': 'eva-admin-',
                'create_tool': 'codex_task_create', 'send_tool': 'codex_task_send',
                'status_tool': 'codex_task_status', 'ack_tool': 'codex_task_reconcile',
                'executor_uid': 1001, 'dedicated_user': 'codex-house-01a16f9f',
                'authority': 'same_authorized_server_goal_authority_as_owner_thread',
                'expires_at': (1792941922 + 2443945 / 10000000),
                'max_shared_sends_per_24h': 48, 'minimum_spacing_seconds': 60,
                'no_extra_approval_within_standing_goal': True,
                'arbitrary_shell_tool_exposed': False,
                'included_subscription_only': True,
                'identity_scope': 'existing_authenticated_owner_principal;not_unique_chatbot_identity',
                'execution_proof': 'requires actual accepted task and root identity verification',
            }
        return result


if __name__ == '__main__':
    operations.Broker = Broker
    operations.FIELDS.update(diagnostics.FIELDS)
    operations.FIELDS.update({'backup_results': (), 'log_summary': ('service',),
        'operation_submit': ('operation', 'idempotency_key', 'expected_revision', 'target_operation_id'),
        'ha_notifications': ('offset', 'expected_digest')})
    operations.FIELDS.update({n: ('thread_id', 'operation_id', 'intent') for n in old.TOOLS})
    operations.FIELDS.update({n: ('action', 'idempotency_key') for n in legacy.legacy.client.TOOLS})
    operations.FIELDS.update(tasks.FIELDS)
    operations.FIELDS.update(repairs.FIELDS)
    operations.main()
