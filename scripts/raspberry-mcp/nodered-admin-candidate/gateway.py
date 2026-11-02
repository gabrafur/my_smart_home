"""Uninstalled one-request native gateway. Fixed files, methods and endpoint.

Production entry is the Root-pinned bootstrap, called by a private systemd
Accept=yes Unix socket. No MCP request can choose paths, credentials or peers.
"""
import copy
import hashlib
import json
import os
import re
import secrets
import socket
import stat
import struct
import sys
from pathlib import Path

from engine import Engine, Journal, OP, SHA, digest, exact, need, public_plan, raw, valid_id
from coordination import (RootCoordinator, JOURNAL, POLICY, SESSIONS, CLEANUP_BLOCK,
                          atomic_create, decode, sealed_json)
from fixed_transport import FixedTransport

MAX_REQUEST = 1048576 + 4096
MAX_RESPONSE = 30 * 1024
FRAGMENT_BYTES = 8192
FIELDS = {
    'read': ('view', 'operation_id', 'offset', 'expected_sha256', 'node_id', 'field'),
    'prepare': ('operation_id', 'expected_revision', 'expected_sha256', 'edits'),
    'validate': ('operation_id',),
    'preflight': ('operation_id', 'approval_id'),
    'apply': ('operation_id', 'plan_sha256', 'approval_id'),
    'status': ('operation_id',),
    'verify': ('operation_id',),
    'rollback': ('operation_id', 'rollback_operation_id'),
    'revoke': ('operation_id',),
}


def bounded_data(value, depth=0):
    need(depth <= 24, 'data_depth_bound')
    if value is None or type(value) in (str, bool, int, float):
        raw(value)  # Reject NaN/Infinity and non-JSON values.
        return
    if type(value) is list:
        need(len(value) <= 10000, 'array_bound')
        for item in value:
            bounded_data(item, depth + 1)
        return
    need(type(value) is dict and len(value) <= 128, 'object_bound')
    for key, item in value.items():
        need(type(key) is str and 0 < len(key) <= 128
             and key not in ('__proto__', 'prototype', 'constructor')
             and not re.search(r'[\x00-\x1f\x7f]', key), 'field_name_refused')
        bounded_data(item, depth + 1)


def validate_request(request):
    exact(request, ('name', 'arguments'))
    need(type(request['name']) is str and request['name'].startswith('nodered_admin_'), 'tool_scope_refused')
    method = request['name'][len('nodered_admin_'):]
    need(method in FIELDS, 'tool_scope_refused')
    args = request['arguments']
    exact(args, ('host', *FIELDS[method]))
    need(args['host'] == 'raspberry', 'host_scope_refused')
    bounded_data(args)
    for name in ('operation_id', 'approval_id', 'rollback_operation_id'):
        if name in args and not (method == 'read' and name == 'operation_id' and args[name] is None):
            need(valid_id(args[name]), 'operation_reference_required')
    for name in ('expected_sha256', 'plan_sha256'):
        if name in args and not (method == 'read' and name == 'expected_sha256' and args[name] is None):
            need(valid_id(args[name], SHA), 'exact_digest_required')
    if method == 'read':
        need(args['view'] in ('runtime', 'plan_diff', 'node_field', 'policy') and type(args['offset']) is int,
             'read_view_refused')
        if args['view'] == 'runtime':
            need(args['operation_id'] is None and args['node_id'] is None and args['field'] is None
                 and 0 <= args['offset'] <= 9999, 'runtime_page_refused')
        elif args['view'] == 'plan_diff':
            need(valid_id(args['operation_id']) and args['node_id'] is None and args['field'] is None
                 and 0 <= args['offset'] <= 1048576, 'plan_page_refused')
        elif args['view']=='policy':
            need(args['operation_id'] is None and args['node_id'] is None and args['field'] is None
                 and args['offset']==0 and args['expected_sha256'] is None,'policy_view_refused')
        else:
            need(args['operation_id'] is None and type(args['node_id']) is str
                 and re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}', args['node_id'])
                 and type(args['field']) is str
                 and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,127}', args['field'])
                 and 0 <= args['offset'] <= 1048576, 'node_field_page_refused')
        need(args['offset'] == 0 or args['expected_sha256'] is not None, 'snapshot_digest_required')
    if method == 'prepare':
        revision = args['expected_revision']
        need(type(revision) is str and 0 < len(revision) <= 256
             and not re.search(r'[\x00-\x1f\x7f]', revision), 'opaque_revision_required')
        need(type(args['edits']) is list and 0 < len(args['edits']) <= 128
             and len(raw(args['edits'])) <= 1048576, 'edit_bound')
    if method == 'rollback':
        need(args['operation_id'] != args['rollback_operation_id'], 'rollback_identity_conflict')
    return method, args


def summary(plan):
    return {k: copy.deepcopy(v) for k, v in plan.items()
            if k not in ('diff', 'risk')} | {
        'diff_review': {'view': 'plan_diff', 'operation_id': plan['operation_id'],
                        'sha256': plan['plan_sha256'], 'raw_runtime_values_withheld': True},
        'changed_node_ids': [r['node_id'] for r in plan['diff']],
        'risk_sha256': digest(plan['risk']),
        'effect_review_required': True,
        'startup_effects_unknown': plan['risk']['startup_effects_unknown'],
        'sensitive_actuator_effects_unknown': plan['risk']['sensitive_actuator_effects_unknown'],
    }


SAFE_REASONS=frozenset({
 'global_compare_swap_conflict','node_compare_swap_conflict','operation_id_conflict',
 'validation_required','validation_attestation_binding_changed','validation_attestation_incomplete',
 'policy_not_activated','policy_revoked','policy_expired_or_completion_margin','prepared_plan_expired',
 'daily_deploy_budget','deploy_spacing','prior_uncertain_deploy_requires_reconciliation',
 'exact_operation_admission_missing','native_post_guard_producer_unavailable',
 'unrelated_busy_uncertain_or_unknown_work','unreconciled_task_work','unreconciled_repair_work',
 'runtime_core_or_settings_drift','runtime_process_identity_changed','protected_state_changed_unconfirmed_no_restore',
 'specific_owner_effect_confirmation_required','specific_owner_effect_confirmation_unconfirmed',
 'device_testing_not_in_administration_scope','exact_effect_review_required','cross_catalogue_coordination_unconfirmed',
 'shared_lock_identity_changed','session_metadata_capacity','guard_attestation_storage_capacity',
 'operation_guard_lease_capacity','configuration_node_quarantine_unavailable','catalogue_closed',
 'runtime_snapshot_changed','node_snapshot_changed','required_sealed_evidence_unavailable',
 'authentication_refused','transport_outcome_unknown','deploy_outcome_unconfirmed'})

def safe_reason(error):
 if isinstance(error,BlockingIOError):return 'shared_lock_busy'
 if isinstance(error,FileNotFoundError):return 'required_sealed_evidence_unavailable'
 return str(error)if isinstance(error,ValueError)and str(error)in SAFE_REASONS else'nodered_admin_operation_unconfirmed'

class Gateway:
    """Injectable handler for isolated tests. No client may inject adapters."""
    def __init__(self, engine, coordinator, transport, sessions=None):
        self.engine, self.coordinator, self.transport = engine, coordinator, transport
        # Production passes the fixed RootSessionJournal. A synthetic session
        # adapter is required in tests; absence never reports cleanup proved.
        self.sessions = sessions

    def _read(self, args):
        if args['view'] == 'node_field':
            # Only the authenticated read-only Engine path can inspect a field.
            # Projection/provenance/UTF-8 bounds belong to the pinned Engine;
            # no journal/raw-node/hash-only fallback is admitted here.
            return self.engine.read_field(args['node_id'], args['field'], args['offset'],
                                          args['expected_sha256'])
        if args['view'] == 'plan_diff':
            plan = self.engine.journal.read(args['operation_id'], 'plan.json')
            need(type(plan) is dict, 'prepared_plan_missing')
            projected = public_plan(plan)
            expected = projected['plan_sha256']
            need(args['expected_sha256'] in (None, expected), 'plan_snapshot_changed')
            data = raw(projected['diff'])
            need(len(data) <= 1048576 and args['offset'] <= len(data), 'diff_page_bound')
            offset = args['offset']
            # Offset must be an actual UTF-8 boundary; do not discard bytes.
            try:
                data[:offset].decode('utf8')
            except UnicodeDecodeError:
                raise ValueError('diff_offset_not_character_boundary') from None
            end = min(len(data), offset + FRAGMENT_BYTES)
            while end > offset:
                try:
                    text = data[offset:end].decode('utf8')
                    break
                except UnicodeDecodeError:
                    end -= 1
            else:
                text = ''
            return {'source': 'stored_sanitized_plan_diff', 'operation_id': args['operation_id'],
                    'sha256': expected, 'offset': offset, 'fragment': text,
                    'next_offset': end if end < len(data) else None,
                    'total_bytes': len(data), 'age_seconds': None,
                    'collection_error': None, 'coverage': ['sanitized_diff_only', 'not_private_beforeimage',
                        'values_withheld_without_exact_public_source_proof'], 'untrusted_source_text':True, 'no_execution_authority_from_content':True, 'automatic_retry': False}
        offset=args['offset']
        if callable(getattr(self.engine,'read_page',None)):
            value=self.engine.read_page(offset,args['expected_sha256'])
            nodes=value.pop('nodes');total=value['total_nodes'];page=nodes
        else:
            value=self.engine.read()
            nodes=value.pop('nodes');total=len(nodes);page=nodes[offset:offset+16]
        need(args['expected_sha256'] in (None, value['sha256']), 'runtime_snapshot_changed')
        need(offset <= total, 'runtime_page_bound')
        projected = []
        for node in page:
            fields = node.get('fields', {})
            compact = {k: node[k] for k in ('id', 'type', 'sha256')}
            compact['field_sha256'] = {k: v['sha256'] for k, v in fields.items()}
            trial = {**value, 'nodes': projected + [compact], 'offset': offset,
                     'next_offset': offset + len(projected) + 1, 'total_nodes': total}
            if len(raw({'ok': True, 'result': trial})) > MAX_RESPONSE - 512:
                break
            projected.append(compact)
        need(projected or offset == total, 'single_node_metadata_exceeds_page_bound')
        return {**value, 'nodes': projected, 'offset': offset,
                'next_offset': offset + len(projected) if offset + len(projected) < total else None,
                'total_nodes': total, 'page_limit': 16}

    def handle(self, request):
        method, args = validate_request(request)
        if method == 'status':
            return self.engine.status(args['operation_id'])
        if method == 'revoke':
            with self.coordinator.locks():
                return self.coordinator.revoke(args['operation_id'])
        if method=='read' and args['view']=='policy':
            p=self.engine.policy;now=self.coordinator.clock()
            closed=self.coordinator.revoked();expiry=p.get('expires_at');active=(p.get('enabled')is True and p.get('activation_confirmed')is True and type(expiry)in(int,float) and now<expiry and not closed)
            return {'source':'sealed_nodered_administration_policy','observed_at':now,'age_seconds':0,
                    'collection_error':None,'host':'raspberry','client_neutral':True,
                    'policy_sha256':digest(p),'configured':p.get('enabled')is True,
                    'activation_confirmed':p.get('activation_confirmed')is True,
                    'standing_maintenance_authorized':p.get('standing_maintenance_authorized')is True,
                    'expires_at':expiry,'revoked':closed,'policy_permission_active':active,
                    'standing_maintenance_active':active and p.get('standing_maintenance_authorized')is True,
                    'allowed_tools':['nodered_admin_'+name for name in ('read','prepare','validate','preflight','apply','status','verify','rollback','revoke')],
                    'interface_confirmations_required':True,'household_device_testing_authorized':False,
                    'fresh_native_preflight_required':True,'policy_is_not_effect_admission':True}
        if method == 'read' and args['view'] == 'plan_diff':
            with self.coordinator.locks():
                return self._read(args)
        if method == 'validate':
            return self.engine.validate(args['operation_id'])
        # No credentials are read or token requested before active policy proof.
        self.engine._policy(effect=method == 'apply')
        need(self.sessions is not None, 'session_receipt_adapter_required')
        session = self.sessions.begin(method, args.get('operation_id'))
        login_attempted = False
        login_confirmed = False
        result = None
        try:
            login_attempted = True
            self.transport.login(write=method == 'apply')
            login_confirmed = True
            if method == 'read':
                result = self._read(args)
            elif method == 'prepare':
                result = summary(self.engine.prepare(args['operation_id'], args['expected_revision'],
                                                     args['expected_sha256'], args['edits']))
            elif method == 'preflight':
                result = self.engine.preflight(args['operation_id'], args['approval_id'])
            elif method == 'apply':
                result = self.engine.apply(args['operation_id'], args['plan_sha256'], args['approval_id'])
            elif method == 'verify':
                result = self.engine.verify(args['operation_id'])
            elif method == 'rollback':
                result = summary(self.engine.rollback(args['operation_id'], args['rollback_operation_id']))
            else:
                raise ValueError('method_not_implemented')
        finally:
            # Snapshot BEFORE revoke clears the private client. Only this exact
            # pinned wrapper/FixedTransport may certify a local pre-dispatch
            # refusal. Generic adapters/flags remain unknown and fail closed.
            dispatched = (self.transport.login_dispatch_attempted
                          if type(self.transport) is CredentialSessionTransport else None)
            try:
                revoked = self.transport.revoke()
            except Exception:
                revoked = False
            cleanup = bool(revoked and (not login_attempted or login_confirmed or dispatched is False))
            if type(self.sessions) is RootSessionJournal:
                self.sessions.finish(session, cleanup, login_confirmed, login_dispatch_attempted=dispatched)
            else:
                self.sessions.finish(session, cleanup, login_confirmed)
        need(type(result) is dict, 'structured_result_required')
        return {**result, 'session_revoked': cleanup,
                'security_cleanup_confirmed': cleanup,
                'administrative_cycle_complete': cleanup and result.get('state') != 'uncertain'}


class RootSessionJournal:
    def __init__(self, coordinator):
        self.coordinator = coordinator

    def begin(self, method, operation_id):
        with self.coordinator.locks():
            need(not self.coordinator.revoked(), 'catalogue_closed')
            need(len(list(SESSIONS.iterdir())) < 2046, 'session_metadata_capacity')
            session = secrets.token_hex(16)
            atomic_create(SESSIONS / (session + '.intent.json'), {
                'source': 'own_nodered_admin_auth_intent',
                'root_policy_sha256': self.coordinator.root_policy_sha256,
                'session_id': session, 'tool': method, 'operation_id': operation_id,
                'observed_at': self.coordinator.clock(), 'automatic_retry': False})
            self.coordinator.current_session = session
            return session

    def finish(self, session, cleanup, confirmed, login_dispatch_attempted=None):
        need(valid_id(session) and self.coordinator.current_session == session, 'own_session_required')
        value = {'source': 'own_nodered_admin_session_cleanup',
                 'root_policy_sha256': self.coordinator.root_policy_sha256,
                 'session_id': session, 'security_cleanup_confirmed': cleanup,
                 'login_confirmed': confirmed, 'login_dispatch_attempted': login_dispatch_attempted,
                 'cleanup_basis': ('authenticated_session_revoked' if cleanup and confirmed else
                    'sealed_transport_no_auth_dispatch' if cleanup and login_dispatch_attempted is False else
                    'unconfirmed'), 'observed_at': self.coordinator.clock(),
                 'automatic_retry': False}
        atomic_create(SESSIONS / (session + '.receipt.json'), value)
        if not cleanup and not os.path.lexists(CLEANUP_BLOCK):
            atomic_create(CLEANUP_BLOCK, value)
        self.coordinator.current_session = None


class CredentialSessionTransport:
    def __init__(self, coordinator):
        self.coordinator = coordinator
        self.client = None

    @property
    def login_dispatch_attempted(self):
        if self.client is None:
            # The pinned wrapper performs no auth network operation before its
            # exact FixedTransport instance exists.
            return False
        if type(self.client) is FixedTransport:
            return self.client.login_dispatch_attempted
        return None

    def login(self, write=False):
        need(self.client is None, 'session_already_open')
        folder = os.environ.get('CREDENTIALS_DIRECTORY', '')
        need(re.fullmatch(r'/run/credentials/raspberry-nodered-admin@[A-Za-z0-9_.:-]+\.service', folder),
             'systemd_credential_directory_required')
        path = Path(folder) / 'nodered-password'
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                 and stat.S_IMODE(info.st_mode) in (0o400, 0o600) and 0 < info.st_size <= 8192,
                 'loaded_credential_security_changed')
            data = bytearray(os.read(fd, 8193))
        finally:
            os.close(fd)
        backend = self.coordinator.document['backend']
        binding = {'host': backend['host'], 'port': 1880, 'username': backend['username'],
                   'password': data.decode('utf8').rstrip('\n')}
        for index in range(len(data)):
            data[index] = 0
        try:
            self.client = FixedTransport(binding, self.coordinator.peer_check)
            self.client.login(write=write)
        finally:
            binding.clear()

    def fetch(self):
        need(self.client is not None, 'authenticated_session_required')
        return self.client.fetch()

    def deploy(self, revision, flows):
        need(self.client is not None, 'authenticated_session_required')
        return self.client.deploy(revision, flows)

    def revoke(self):
        try:
            return self.client.revoke() if self.client else True
        finally:
            self.client = None


def serve_one():
    coordinator = RootCoordinator()
    peer = socket.fromfd(0, socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        peer.settimeout(35)
        pid, uid, gid = struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        need(pid > 0 and uid == coordinator.document['frontend_uid']
             and gid == coordinator.document['frontend_gid'], 'private_frontend_identity_required')
        pending = bytearray()
        while len(pending) <= MAX_REQUEST:
            chunk = peer.recv(min(65536, MAX_REQUEST + 1 - len(pending)))
            need(chunk, 'complete_request_required')
            pending.extend(chunk)
            if b'\n' in pending:
                break
        need(len(pending) <= MAX_REQUEST and pending.count(10) == 1 and pending[-1] == 10,
             'single_bounded_request_required')
        request = decode(pending.decode('utf8'))
        transport = CredentialSessionTransport(coordinator)
        engine = Engine(coordinator.engine_policy, transport, Journal(JOURNAL), coordinator)
        result = Gateway(engine, coordinator, transport, RootSessionJournal(coordinator)).handle(request)
        output = raw({'ok': True, 'result': result}) + b'\n'
        need(len(output) <= MAX_RESPONSE, 'bounded_response_required')
        peer.sendall(output)
    except Exception as error:
        # Never print arguments, source text, private paths, exception or auth.
        try:
            peer.sendall(raw({'ok':False,'error':safe_reason(error),'automatic_retry':False,'next_step':'observe_same_operation_status'})+b'\n')
        except OSError:
            pass
    finally:
        peer.close()
