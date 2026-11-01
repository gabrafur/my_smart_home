"""Uninstalled wrapper of the existing storage broker. No general admin grant."""
import importlib.util
import os
from pathlib import Path
import sys

LIB = '/usr/local/lib/raspberry-nodered-binding'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def component_guard_query(name, arguments):
    # Called only by fixed native dispatch while operations.main holds its flock.
    # No arbitrary path, principal, operation, acceptance or command is supplied.
    import json, socket, stat, struct
    from pathlib import Path
    path = '/run/raspberry-component-guard.sock'
    info = Path(path).lstat()
    if not (stat.S_ISSOCK(info.st_mode) and info.st_uid == 0 and
            stat.S_IMODE(info.st_mode) == 0o660):
        raise ValueError('component_guard_identity_unconfirmed')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
        peer.settimeout(4)
        peer.connect(path)
        _, uid, _ = struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != 0:
            raise ValueError('component_guard_peer_refused')
        peer.sendall((json.dumps({'name': name, 'arguments': arguments}, separators=(',', ':')) + '\n').encode())
        data = bytearray()
        while b'\n' not in data:
            part = peer.recv(4096)
            if not part or len(data) + len(part) > 16384:
                raise ValueError('component_guard_reply_unconfirmed')
            data.extend(part)
    if data.count(b'\n') != 1 or not data.endswith(b'\n'):
        raise ValueError('component_guard_reply_unconfirmed')
    value = json.loads(data)
    if not (type(value) is dict and value.get('ok') is True and type(value.get('result')) is dict):
        raise ValueError('component_scope_reserved_or_unconfirmed')
    return value['result']


def component_mutation_guard(kind):
    proof = component_guard_query('_registered_mutation_guard', {'host': 'raspberry', 'kind': kind})
    if not (proof.get('source') == 'protected_component_reservation_ledger_under_operations_lock' and
            proof.get('collection_error') is None and proof.get('admission_allowed') is True):
        raise ValueError('component_scope_reserved_or_unconfirmed')


def component_catalogue_observe():
    try:
        value = component_guard_query('_component_catalogue_status', {'host': 'raspberry'})
        if value.get('source') != 'protected_registered_component_catalogue':
            raise ValueError('component_metadata_source_changed')
        return value
    except Exception:
        return {'source': 'protected_registered_component_catalogue', 'state': 'unknown',
                'observed_at': None, 'age_seconds': None,
                'collection_error': 'protected_component_catalogue_unavailable',
                'execution_active': False, 'recurring_execution_enabled': False,
                'coverage': ['catalogue_not_execution_or_functional_health']}


def component_effect_kind(name, args):
    # Observation and reconciliation stay available; previews do not mutate the
    # active household source. New native mutation paths need an explicit gate.
    if name in ('codex_task_create', 'codex_task_send', 'codex_repair_submit'):
        return 'scoped_codex_task'
    if name == 'codex_thread_send':
        return 'legacy_codex_send'
    if name in ('change_apply', 'change_revert'):
        return 'generic_project_source_mutation'
    if name == 'operation_submit':
        if type(args) is dict and args.get('operation') in (
                'deploy_icloud_manual_auth', 'contain_icloud_manual_auth'):
            return 'native_icloud_deployment'
        return 'generic_project_source_mutation'
    if name == 'admin_action_apply':
        action = args.get('action') if type(args) is dict else None
        if action in ('nodered_apply_reader_binding', 'nodered_restore_reader_binding'):
            return 'NodeRED_reader_binding'
        if action in ('nodered_plan_reader_binding', 'nodered_plan_restore_reader_binding'):
            return None
        if type(action) is str and action.startswith('storage_plan_'):
            return None
        return 'legacy_notice_migration' if action == 'migrate_two_notice_aliases' else 'generic_project_source_mutation'
    return None


def compose(prior, binding_client):
    import controller
    class Broker(prior):
        def handle(self, name, args):
            kind = component_effect_kind(name, args)
            if kind is not None:
                component_mutation_guard(kind)
            if name in controller.TOOLS and type(args) is dict and \
                    type(args.get('action')) is str and args['action'].startswith('nodered_'):
                return binding_client.request(name, args)
            result = super().handle(name, args)
            if name == 'maintenance_capabilities':
                result['evidence']['data']['protected_component_maintenance'] = component_catalogue_observe()
                try:
                    admission = binding_client.request('binding_metadata_observe', {'host': 'raspberry'})
                except Exception:
                    admission = {'source': 'fixed_NodeRED_binding_extension', 'state': 'unknown',
                        'observed_at': None, 'age_seconds': None,
                        'collection_error': 'binding_admission_unavailable',
                        'execution_active': False, 'recurring_execution_enabled': False,
                        'coverage': ['prior_capabilities_preserved', 'no_effect_or_automatic_retry']}
                result['evidence']['data']['limited_NodeRED_reader_binding_catalogue'] = admission
            return result
    return Broker


if __name__ == '__main__':
    if os.geteuid() != 1001 or Path(__file__) != Path(LIB + '/broker.py'):
        raise ValueError('sealed_unprivileged_binding_broker_entrypoint_required')
    sys.path.insert(0, LIB)
    import runpy
    binding_runtime = globals().get('_BOOT_RUNTIME')
    binding_client = globals().get('_BOOT_CLIENT')
    if binding_runtime is None or binding_client is None:
        raise ValueError('sealed_binding_bootstrap_required')
    policy = binding_runtime.load_policy()
    binding_runtime.previous_identity(policy, binding_runtime.LEGACY_BROKER)
    legacy = load('binding_prior_storage_broker', binding_runtime.LEGACY_BROKER)
    Broker = compose(legacy.Broker, binding_client)
    # Preserve the actual proven storage/repair/task broker implementation.
    # Only its factory is composed; no existing action or ledger is rewritten.
    original = legacy.legacy.operations.main

    def main():
        legacy.legacy.operations.Broker = Broker
        legacy.legacy.operations.FIELDS['storage_metadata_read'] = ()
        return original()

    legacy.legacy.operations.main = main
    runpy.run_path('/usr/local/lib/raspberry-repair-control/repair-broker.py', run_name='__main__')
