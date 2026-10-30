"""Closed public action catalogue, independent of execution or scheduling."""
import re
from datetime import datetime, timezone

SCOPES = ('npm_logs', 'npm_temporary')
ACTIONS = {f'storage_{verb}_{scope}': (verb, scope)
           for scope in SCOPES for verb in ('plan', 'quarantine', 'restore')}
ACTIONS['storage_revoke_cache_cleanup'] = ('revoke', None)
TOOLS = ('admin_action_apply', 'admin_action_status', 'admin_action_reconcile', 'admin_action_revoke')


def validate(tool, args):
    if (tool not in TOOLS or type(args) is not dict
            or set(args) != {'host', 'action', 'idempotency_key'} or args.get('host') != 'raspberry'
            or type(args.get('action')) is not str or args['action'] not in ACTIONS
            or type(args.get('idempotency_key')) is not str
            or not re.fullmatch(r'storage-[a-f0-9]{32}', args['idempotency_key'])):
        raise ValueError('storage_scope_refused')
    verb, scope = ACTIONS[args['action']]
    if (tool == 'admin_action_revoke') != (verb == 'revoke'):
        raise ValueError('storage_action_tool_mismatch')
    if tool in ('admin_action_status', 'admin_action_reconcile'):
        verb = 'status'  # Observation only; uncertainty never resubmits an operation.
    return verb, scope, args['idempotency_key'][8:]


def catalogue():
    return {'source': 'versioned_closed_cache_maintenance_catalogue',
            'observed_at': datetime.now(timezone.utc).isoformat(), 'age_seconds': 0,
            'collection_error': None,
            'execution_approval_required': True, 'recurring_execution_enabled': False,
            'actions': [{'scope': scope, 'minimum_age_seconds': age,
                         'target': target, 'recoverable': True,
                         'plan_action': f'storage_plan_{scope}',
                         'execution_action': f'storage_quarantine_{scope}',
                         'restore_action': f'storage_restore_{scope}'}
                        for scope, age, target in (
                            ('npm_logs', 1209600, 'fixed_owner_npm_debug_and_timing_logs'),
                            ('npm_temporary', 604800, 'fixed_owner_npm_content_cache_temporary_files'))],
            'maximum_items_per_batch': 32, 'maximum_bytes_per_batch': 16777216,
            'maximum_batches_per_24h': 4, 'minimum_spacing_seconds': 21600,
            'maximum_retained_quarantine_bytes': 536870912,
            'plan_validity_seconds': 900, 'maximum_operation_history': 64,
            'preconditions': ['regular_single_link_owner_file_known_name_and_age',
                              'unchanged_device_inode_size_timestamps_owner_mode',
                              'exclusive_kernel_write_lease', 'shared_maintenance_lock',
                              'at_least_2GiB_memory_and_disk_available_and_15_percent_disk_available',
                              'gzip_round_trip_verified_before_unlinking_staged_cache_file'],
            'protected': ['Docker_volumes_and_images', 'databases', 'configuration', 'credentials',
                          'personal_files', 'backups', 'snapshots', 'restore_workspaces'],
            'coverage': ['catalogue_not_runtime_admission_or_execution_receipt',
                         'no_shell_commands_or_caller_paths', 'no_automatic_permanent_deletion',
                         'health_and_webhook_paths_never_invoke_cleanup']}
