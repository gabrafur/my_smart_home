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


# Fixed reviewed documentation, appended as virtual rows to the native catalogue.
# The receipt contains no authority to edit files or execute commands.
REVIEWED_ROOT = '/mnt/data/docker'
REVIEWED_RECEIPT = '/usr/local/lib/raspberry-mcp-reviewed-public-docs.json'
REVIEWED_PATHS = ('docs/raspberry-mcp/README.md', 'docs/raspberry-mcp/tools.md',
                  'docs/raspberry-mcp/reference/nodered-reader-binding.md')
REVIEWED_LIMIT = 262144


def reviewed_ids():
    import hashlib
    return {hashlib.sha256(('reviewed-public-doc-v1:' + path).encode()).hexdigest()[:32]: path
            for path in REVIEWED_PATHS}


def reviewed_receipt():
    import datetime, json, re
    import native_manager
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('reviewed_docs_receipt_invalid')
            result[key] = value
        return result
    try:
        _, raw, _ = native_manager.root_file(REVIEWED_RECEIPT, maximum=4096)
        value = json.loads(raw, object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('invalid_constant')))
        if (type(value) is not dict or set(value) != {'schema_version', 'source', 'public_head', 'observed_at', 'files'}
                or type(value['schema_version']) is not int or value['schema_version'] != 1
                or value['source'] != 'reviewed_public_MCP_docs_v1'
                or not isinstance(value['public_head'], str) or not re.fullmatch(r'[a-f0-9]{40}', value['public_head'])
                or type(value['files']) is not dict or set(value['files']) != set(REVIEWED_PATHS)
                or any(not isinstance(v, str) or not re.fullmatch(r'[a-f0-9]{64}', v) for v in value['files'].values())
                or not isinstance(value['observed_at'], str)):
            raise ValueError('reviewed_docs_receipt_invalid')
        stamp = datetime.datetime.fromisoformat(value['observed_at'].replace('Z', '+00:00'))
        now = datetime.datetime.now(datetime.timezone.utc)
        if stamp.tzinfo is None or stamp.utcoffset() != datetime.timedelta(0) or stamp > now:
            raise ValueError('reviewed_docs_receipt_invalid')
        return value, (now-stamp).total_seconds()
    except (OSError, ValueError, TypeError, KeyError, OverflowError):
        raise ValueError('reviewed_docs_receipt_unavailable') from None


def reviewed_file(path, expected):
    import hashlib, stat
    if path not in REVIEWED_PATHS:
        raise ValueError('reviewed_docs_scope_refused')
    try:
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            parts = REVIEWED_ROOT.strip('/').split('/') + path.split('/')
            for part in parts[:-1]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd); fd = child
            source = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        finally:
            os.close(fd)
        try:
            before = os.fstat(source)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > REVIEWED_LIMIT:
                raise ValueError('reviewed_docs_file_invalid')
            data = bytearray()
            while len(data) <= REVIEWED_LIMIT:
                chunk = os.read(source, min(8192, REVIEWED_LIMIT + 1 - len(data)))
                if not chunk: break
                data.extend(chunk)
            after = os.fstat(source)
            fields = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
            if (fields(before) != fields(after) or len(data) != before.st_size
                    or len(data) > REVIEWED_LIMIT or hashlib.sha256(data).hexdigest() != expected
                    or b'\x00' in data):
                raise ValueError('reviewed_docs_file_invalid')
            return bytes(data).decode('utf-8', errors='strict')
        finally:
            os.close(source)
    except (OSError, ValueError, UnicodeError):
        raise ValueError('reviewed_docs_file_unavailable_or_changed') from None


def reviewed_context(receipt, age):
    return {'source': 'root_owned_reviewed_public_docs_receipt', 'state': 'observed',
            'observed_at': receipt['observed_at'], 'age_seconds': round(age, 3),
            'collection_error': None, 'reviewed_head': receipt['public_head'],
            'coverage': ['receipt_time_not_live_git_head', 'fixed_paths_hash_checked_each_read',
                         'read_only_no_write_authority']}


def compose(prior, binding_client):
    import controller
    class Broker(prior):
        def handle(self, name, args):
            identifiers = reviewed_ids()
            if (name in ('project_read', 'project_prepare_edit') and type(args) is dict
                    and isinstance(args.get('file_id'), str) and args['file_id'] in identifiers):
                if args['file_id'] in self.catalog:
                    raise ValueError('reviewed_docs_id_collision')
                if name == 'project_prepare_edit':
                    raise ValueError('read_only_catalog_target')
                if (set(args) != {'host', 'file_id', 'offset'} or args['host'] != 'raspberry'
                        or type(args['offset']) is not int or not 0 <= args['offset'] <= REVIEWED_LIMIT):
                    raise ValueError('invalid_parameters')
                receipt, age = reviewed_receipt()
                path = identifiers[args['file_id']]
                content = reviewed_file(path, receipt['files'][path])
                offset = args['offset']
                if offset > len(content):
                    raise ValueError('reviewed_docs_offset_out_of_range')
                context = reviewed_context(receipt, age)
                return {'path': path, 'sha256': receipt['files'][path], 'text': content[offset:offset+4000],
                        'next_offset': offset+4000 if offset+4000 < len(content) else None,
                        'deployment': 'source_only', **context, 'reviewed_observation': context}
            kind = component_effect_kind(name, args)
            if kind is not None:
                component_mutation_guard(kind)
            if name in controller.TOOLS and type(args) is dict and \
                    type(args.get('action')) is str and args['action'].startswith('nodered_'):
                return binding_client.request(name, args)
            result = super().handle(name, args)
            if (name == 'project_files' and type(args) is dict and args.get('category') == 'docs'
                    and args.get('offset') == 0):
                if any(identifier in self.catalog for identifier in identifiers):
                    raise ValueError('reviewed_docs_id_collision')
                try:
                    receipt, age = reviewed_receipt()
                    for path in REVIEWED_PATHS:
                        reviewed_file(path, receipt['files'][path])
                except ValueError as exc:
                    reason = str(exc) if str(exc) in ('reviewed_docs_receipt_unavailable',
                        'reviewed_docs_file_unavailable_or_changed') else 'reviewed_docs_unavailable'
                    result['reviewed_observation'] = {
                        'source': 'root_owned_reviewed_public_docs_receipt', 'state': 'unknown',
                        'observed_at': None, 'age_seconds': None, 'collection_error': reason,
                        'coverage': ['prior_catalog_preserved', 'no_unverified_roots']}
                    result['reviewed_virtual_roots'] = 0
                else:
                    result['files'] = result['files'] + [
                        {'file_id': identifier, 'path': path, 'read_only': True}
                        for identifier, path in identifiers.items()]
                    result['reviewed_observation'] = reviewed_context(receipt, age)
                    result['reviewed_virtual_roots'] = len(identifiers)
                    result['pagination_semantics'] = 'offset_applies_to_static_catalog;reviewed_docs_only_on_first_page'
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
