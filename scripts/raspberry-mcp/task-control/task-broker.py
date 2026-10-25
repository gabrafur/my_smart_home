"""Overlay only: preserve installed notices, Events and administrative routing."""
import importlib.util
import sys

sys.path.insert(0, '/usr/local/lib/raspberry-task-control')
sys.path.insert(0, '/usr/local/lib/raspberry-mcp')
import operations
import maintenance_diagnostics as diagnostics
import codex_control as old
import task_control as tasks

spec = importlib.util.spec_from_file_location('sealed_admin_broker',
    '/usr/local/lib/raspberry-admin-executor/admin-broker.py')
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)


class Broker(legacy.Broker):
    def handle(self, name, args):
        if name in tasks.TOOLS:
            return tasks.handle(name, args, old)
        if name in old.TOOLS:
            old.validate(name, args)
            return tasks.legacy_call(name, args, old, super().handle)
        # Existing administrative executor and all producer reads remain intact.
        return super().handle(name, args)


if __name__ == '__main__':
    operations.Broker = Broker
    operations.FIELDS.update(diagnostics.FIELDS)
    operations.FIELDS.update({
        'backup_results': (), 'log_summary': ('service',),
        'operation_submit': ('operation', 'idempotency_key', 'expected_revision', 'target_operation_id'),
        'ha_notifications': ('offset', 'expected_digest')})
    operations.FIELDS.update({n: ('thread_id', 'operation_id', 'intent') for n in old.TOOLS})
    operations.FIELDS.update({n: ('action', 'idempotency_key') for n in legacy.client.TOOLS})
    operations.FIELDS.update(tasks.FIELDS)
    operations.main()
