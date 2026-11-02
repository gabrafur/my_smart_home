"""UNINSTALLED sealed factory. No self-installation, scheduling or free paths."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time

import controller
import durable_store
import native_manager

LIB = Path('/usr/local/lib/raspberry-nodered-binding')
POLICY = LIB / 'approval.json'
STATE = Path('/var/lib/raspberry-nodered-binding')
COMMON = Path('/run/raspberry-storage-inputs/daily-maintenance.lock')
FILES = ('bootstrap.py', 'controller.py', 'durable_store.py', 'native_manager.py', 'runtime.py',
         'server.py', 'client.py', 'broker.py')
_BOOT_POLICY_SHA256 = None
LEGACY_SERVER = '/usr/local/lib/raspberry-mcp-storage/server.py'
LEGACY_BROKER = '/usr/local/lib/raspberry-mcp-storage/broker.py'


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


# This schema describes a separately approved client, never an executor grant.
CLIENT_EVENT_RULES = {
    'kind': 'client_response_to_natural_reader_diagnostic_failures',
    'expires_at': None,
    'target': controller.UNIT,
    'actions': ['nodered_plan_reader_binding', 'nodered_apply_reader_binding'],
    'interface_confirmations_required': True,
    'maximum_writes_per_24h': 4,
    'minimum_spacing_seconds': 600,
    'plan_validity_seconds': 900,
    'maximum_applies_per_incident': 1,
    'maximum_inactive_wait_seconds': 30,
    'server_scheduling_enabled': False,
    'automatic_restart_enabled': False,
    'automatic_task_enabled': False,
    'automatic_device_enabled': False,
    'automatic_restore_enabled': False,
}


def validate_client_event_policy(value):
    need(type(value) is dict and set(value) == set(CLIENT_EVENT_RULES) | {'enabled', 'approval_sha256'},
         'client_event_policy_fields_refused')
    need(type(value['enabled']) is bool and type(value['approval_sha256']) is str and
         re.fullmatch('[a-f0-9]{64}', value['approval_sha256']) is not None,
         'client_event_policy_authority_refused')
    need(all(type(value[key]) is type(expected) and value[key] == expected
             for key, expected in CLIENT_EVENT_RULES.items()), 'client_event_policy_scope_refused')
    return value


def client_event_projection(policy, revoked):
    result = {'source': 'sealed_root_reader_client_event_policy',
              'observed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'age_seconds': 0, 'collection_error': None,
              'state': 'approval_pending', 'approval_active': False,
              'execution_proven': False, 'server_scheduling_enabled': False,
              'interface_confirmations_required': True,
              'coverage': ['client_approval_not_executor_admission_or_execution']}
    if 'client_event_policy' not in policy:
        return result
    value = policy['client_event_policy']
    try:
        validate_client_event_policy(value)
    except (ValueError, TypeError):
        result.update(state='unknown', collection_error='client_event_policy_unverified')
        return result
    if revoked is not False:
        result['state'] = 'revoked' if revoked is True else 'unknown'
        if revoked is not True:
            result['collection_error'] = 'client_event_policy_revocation_unverified'
    elif not value['enabled']:
        result['state'] = 'disabled'
    else:
        result.update(state='approved', approval_active=True, approval_sha256=value['approval_sha256'],
                      policy={**CLIENT_EVENT_RULES, 'actions': list(CLIENT_EVENT_RULES['actions'])})
    return result


def load_policy():
    _, raw, _ = native_manager.root_file(str(POLICY), maximum=32768)
    need(type(_BOOT_POLICY_SHA256) is str and hashlib.sha256(raw).hexdigest() == _BOOT_POLICY_SHA256,
         'unit_pinned_binding_policy_changed_or_bootstrap_missing')
    value = json.loads(raw, object_pairs_hook=durable_store.unique)
    fields = {'schema_version', 'project', 'approved_until_revoked',
        'source_hashes', 'controller_policy', 'binary_hashes', 'dependency_hashes',
        'common_lock_identity', 'legacy_server_sha256', 'legacy_broker_sha256'}
    need(type(value) is dict and set(value) in (fields, fields | {'client_event_policy'}),
         'binding_policy_fields_changed')
    if 'client_event_policy' in value:
        validate_client_event_policy(value['client_event_policy'])
    need(value['schema_version'] == 1 and value['project'] == '/mnt/data/docker' and
         value['approved_until_revoked'] is True, 'specific_binding_approval_required')
    hashes = value['source_hashes']
    need(type(hashes) is dict and set(hashes) == set(FILES), 'binding_source_scope_changed')
    for name, expected in hashes.items():
        need(type(expected) is str and re.fullmatch('[a-f0-9]{64}', expected) is not None
             and native_manager.root_file(str(LIB / name))[0] == expected,
             'binding_source_identity_changed')
    need(value['controller_policy']['recurring_execution_enabled'] is False,
         'binding_recurrence_not_authorized')
    controller.Controller(value['controller_policy'], None, None, time.time)
    identity = value['common_lock_identity']
    need(type(identity) is list and len(identity) == 5 and
         all(type(v) is int and v >= 0 for v in identity) and
         identity[2:] == [1001, 1001, 0o664], 'reviewed_common_lock_identity_required')
    return value


def previous_identity(policy, path):
    need(path in (LEGACY_SERVER, LEGACY_BROKER), 'fixed_legacy_delegate_required')
    key = 'legacy_server_sha256' if path == LEGACY_SERVER else 'legacy_broker_sha256'
    need(native_manager.root_file(path)[0] == policy[key], 'legacy_delegate_hash_changed')


def components(policy):
    store = durable_store.Store(STATE, COMMON, policy['common_lock_identity'])
    runner = native_manager.PinnedRunner(policy['binary_hashes'])
    manager = native_manager.Manager(policy['controller_policy'], runner, store,
                                    policy['dependency_hashes'])
    return store, controller.Controller(policy['controller_policy'], store, manager, time.time)


def metadata(policy):
    # Passive discovery never inspects Docker or calls systemd, changes a peer,
    # dispatches an operation or creates a schedule.
    store = durable_store.Store(STATE, COMMON, policy['common_lock_identity'])
    result = {'source': 'sealed_limited_NodeRED_binding_policy_and_ledger',
        'observed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'age_seconds': 0, 'collection_error': None, 'configured': True,
        'execution_active': False, 'recurring_execution_enabled': False,
        'expires_at': None, 'interface_confirmations_required': True,
        'maximum_writes_per_24h': controller.MAXIMUM_PER_24H,
        'minimum_spacing_seconds': controller.MINIMUM_SPACING,
        'maximum_plan_age_seconds': controller.PLAN_SECONDS,
        'actions': list(controller.ACTIONS), 'tools': list(controller.TOOLS),
        'coverage': ['policy_and_ledger_not_live_container_network_or_application_health',
                     'reader_network_binding_only_not_general_NodeRED_deploy_or_repair',
                     'not_Eva_execution_or_whole_goal_acceptance']}
    with store.lock():
        rows = store.history()
        now = time.time()
        effects = [effect['at'] for row in rows for effect in row.get('effects', [])]
        clock_ok = all(type(at) in (int, float) and at <= now for at in effects)
        uncertain = sum(row['state'] in controller.BUSY for row in rows)
        used = sum(now - 86400 <= at <= now for at in effects) if clock_ok else None
        revoked = store.revoked()
        result['client_event_policy'] = client_event_projection(policy, revoked)
        result.update(revoked=revoked, clock_order_confirmed=clock_ok,
            unresolved_operations=uncertain, writes_last_24h=used,
            remaining_writes=None if used is None else max(0, controller.MAXIMUM_PER_24H - used),
            spacing_ready=clock_ok and (not effects or now - max(effects) >= controller.MINIMUM_SPACING),
            live_identity_and_resource_preflight_required=True,
            execution_active=policy['controller_policy']['enabled'] and not revoked and clock_ok
                and uncertain == 0 and used < controller.MAXIMUM_PER_24H
                and (not effects or now - max(effects) >= controller.MINIMUM_SPACING))
        result['new_plan_admission_active'] = result['execution_active'] and len(rows) < 64
    return result


def dispatch(tool, args):
    policy = load_policy()
    if tool == 'binding_native_preflight_observe':
        need(args == {'host': 'raspberry'} and policy['controller_policy']['enabled'] is False,
             'disabled_policy_readonly_native_preflight_required')
        store, engine = components(policy)
        with store.lock():
            need(not store.revoked(), 'binding_catalogue_revoked')
            engine.inspect()
            need(engine.manager.headroom(), 'host_headroom_unconfirmed')
        return {'source': 'sealed_disabled_policy_native_namespace_preflight',
            'observed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'age_seconds': 0, 'collection_error': None,
            'state': 'native_readonly_preflight_passed_policy_disabled',
            'same_reviewed_identity_verified': True, 'headroom_confirmed': True,
            'native_write_calls': 0, 'execution_active': False,
            'probe_pid': os.getpid(),
            'probe_start_ticks': int(Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[19]),
            'coverage': ['native_socket_and_readonly_metadata_under_real_unit_limits',
                         'not_MCP_Eva_interface_or_native_write_acceptance']}
    if tool == 'binding_metadata_observe':
        need(args == {'host': 'raspberry'}, 'fixed_binding_metadata_request_required')
        return metadata(policy)
    controller.validate(tool, args)
    _, engine = components(policy)
    return engine.request(tool, args)
