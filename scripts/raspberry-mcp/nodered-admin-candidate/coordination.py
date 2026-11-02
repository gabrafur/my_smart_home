"""Uninstalled fixed Root coordinator. No shell, subprocess, URL or free paths.

Attestations are immutable files produced by a separately reviewed Root
validator/inspector. No MCP method writes or self-asserts those proofs.
"""
import contextlib
import copy
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import stat
import secrets
import sys
import time

from engine import OP, SHA, digest, exact, need, raw, valid_id

ROOT = Path('/usr/local/lib/raspberry-nodered-admin')
STATE = Path('/var/lib/raspberry-nodered-admin')
POLICY = ROOT / 'policy.json'
JOURNAL = STATE / 'operations'
ATTESTATIONS = STATE / 'attestations'
REVOKED = STATE / 'revoked.json'
SESSIONS = STATE / 'sessions'
CLEANUP_BLOCK = STATE / 'session-unconfirmed.json'
LOCKS = (
    '/tmp/my-smart-home-public-validation.lock',
    '/mnt/data/docker/.daily-maintenance.lock',
    '/var/lib/raspberry-mcp-operations/lock',
    '/var/lib/raspberry-admin-executor/executor.lock',
    '/var/lib/raspberry-mcp-operations/task-control/coordinator.lock',
)
SOURCES = ('engine.py', 'coordination.py', 'gateway.py', 'fixed_transport.py', 'bootstrap.py', 'native_guard.py')


def decode(body):
    def unique(items):
        value = {}
        for key, item in items:
            need(key not in value, 'duplicate_sealed_key')
            value[key] = item
        return value
    return json.loads(body, object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite_sealed_json')))


def checked_read(path, mode=0o600, maximum=262144):
    """All policy/proof ancestors Root-owned, nonwritable, and no symlinks."""
    need(path.is_absolute() and '..' not in path.parts, 'fixed_absolute_path_required')
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for name in path.parts[1:-1]:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
            info = os.fstat(directory)
            need(info.st_uid == 0 and not info.st_mode & 0o022, 'sealed_parent_security_changed')
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    finally:
        os.close(directory)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0
             and stat.S_IMODE(info.st_mode) == mode and info.st_nlink == 1
             and 0 < info.st_size <= maximum, 'sealed_file_security_changed')
        body = os.read(fd, maximum + 1)
        after = os.fstat(fd)
        need(len(body) == info.st_size and
             (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) ==
             (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
             'sealed_file_changed_during_read')
        return body
    finally:
        os.close(fd)


def sealed_json(path):
    value = decode(checked_read(path))
    need(type(value) is dict, 'sealed_object_required')
    return value


def atomic_create(path, value):
    """Fixed caller-chosen-by-code phase path, not a protocol path parameter."""
    parent = path.parent.stat()
    need(parent.st_uid == parent.st_gid == 0 and stat.S_ISDIR(parent.st_mode)
         and stat.S_IMODE(parent.st_mode) == 0o700 and not path.parent.is_symlink(),
         'private_root_state_required')
    body = raw(value) + b'\n'
    need(len(body) <= 32768, 'metadata_bound')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, body)
        os.fsync(fd)
    finally:
        os.close(fd)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


class RootCoordinator:
    def __init__(self, clock=time.time):
        need(os.geteuid() == 0, 'fixed_root_executor_required')
        self.clock = clock
        self.locked = False
        self.current_session = None
        self.lock_lease_id = None
        self.locks_acquired_at = None
        self._held_lock_fds = ()
        self._inline_guard = None
        self._catalog_for_lease = None
        self._catalog_values = {}
        self._catalog_evidence = {}
        policy_raw = checked_read(POLICY)
        self.root_policy_sha256 = hashlib.sha256(policy_raw).hexdigest()
        self.document = decode(policy_raw)
        exact(self.document, ('schema_version', 'engine', 'sources', 'shared_locks',
                              'frontend_uid', 'frontend_gid', 'backend', 'credential_name',
                              'native_guard_producer'))
        need(self.document['schema_version'] == 1 and self.document['frontend_uid'] == 985
             and self.document['frontend_gid'] == 985
             and self.document['credential_name'] == 'nodered-password', 'fixed_identity_policy_changed')
        need(type(self.document['engine']) is dict and set(self.document['sources']) == set(SOURCES)
             and set(self.document['shared_locks']) == set(LOCKS), 'sealed_policy_scope_changed')
        for name in SOURCES:
            expected = self.document['sources'][name]
            need(valid_id(expected, SHA) and hashlib.sha256(checked_read(ROOT / name, 0o644, 1048576)).hexdigest() == expected,
                 'sealed_source_hash_changed')
        self.engine_policy = copy.deepcopy(self.document['engine'])
        need(self.engine_policy.get('host') == 'raspberry'
             and self.engine_policy.get('project') == '/mnt/data/docker', 'fixed_host_project_changed')
        backend = self.document['backend']
        exact(backend, ('host', 'port', 'username', 'identity_sha256'))
        need(type(backend['host']) is str and backend['port'] == 1880
             and type(backend['username']) is str and valid_id(backend['identity_sha256'], SHA),
             'fixed_backend_policy_changed')

    def _unchanged(self):
        need(hashlib.sha256(checked_read(POLICY)).hexdigest() == self.root_policy_sha256,
             'policy_changed_during_operation')

    @contextlib.contextmanager
    def locks(self):
        need(not self.locked, 'nested_coordination_refused')
        self._unchanged()
        held = []
        try:
            for path in LOCKS:
                expected = self.document['shared_locks'][path]
                need(type(expected) is list and len(expected) == 5 and all(type(n) is int for n in expected),
                     'sealed_lock_identity_invalid')
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                held.append(fd)
                info = os.fstat(fd)
                need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                     and not info.st_mode & 0o002 and
                     [info.st_dev, info.st_ino, info.st_uid, info.st_gid,
                      stat.S_IMODE(info.st_mode)] == expected, 'shared_lock_identity_changed')
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.locked = True
            self._held_lock_fds = tuple(held)
            self.lock_lease_id = secrets.token_hex(16)
            self.locks_acquired_at = self.clock()
            self._unchanged()
            yield
        finally:
            self.locked = False
            self._held_lock_fds = ()
            self.lock_lease_id = None
            self.locks_acquired_at = None
            for fd in reversed(held):
                os.close(fd)

    def revoked(self):
        self._unchanged()
        if os.path.lexists(CLEANUP_BLOCK):
            value = sealed_json(CLEANUP_BLOCK)
            need(value.get('source') == 'own_nodered_admin_session_cleanup', 'session_block_unconfirmed')
            return True
        # A killed worker may leave an auth intent before receiving its token.
        # That outcome cannot be silently treated as successful revocation.
        entries = list(SESSIONS.iterdir())
        need(len(entries) <= 2048, 'session_metadata_capacity')
        for entry in entries:
            if not entry.name.endswith('.intent.json'):
                continue
            identifier = entry.name[:-len('.intent.json')]
            need(valid_id(identifier), 'unexpected_session_entry')
            if identifier == self.current_session:
                continue
            receipt = SESSIONS / (identifier + '.receipt.json')
            if not os.path.lexists(receipt):
                return True
            proof = sealed_json(receipt)
            if proof.get('security_cleanup_confirmed') is not True:
                return True
        if not os.path.lexists(REVOKED):
            return False
        value = sealed_json(REVOKED)
        need(value.get('source') == 'own_nodered_admin_revocation'
             and valid_id(value.get('operation_id')), 'revocation_record_unconfirmed')
        return True

    def revoke(self, operation_id):
        need(self.locked and valid_id(operation_id), 'locked_revocation_required')
        self.revoked()  # Independently validate any existing session/closure metadata.
        if os.path.lexists(REVOKED):
            old = sealed_json(REVOKED)
            return {'state': 'already_revoked', 'operation_id': old['operation_id'],
                    'new_effects_disabled': True, 'receipts_preserved': True, 'automatic_retry': False}
        value = {'source': 'own_nodered_admin_revocation', 'operation_id': operation_id,
                 'root_policy_sha256': self.root_policy_sha256, 'observed_at': self.clock(),
                 'new_effects_disabled': True, 'receipts_preserved': True, 'automatic_retry': False}
        atomic_create(REVOKED, value)
        return {**value, 'state': 'revoked'}

    def _proof(self, operation_id, name, maximum_age):
        need(self.locked and valid_id(operation_id)
             and name in ('validation.json', 'admission.json', 'guard-before.json', 'guard-after.json'),
             'fixed_attestation_scope_required')
        self._unchanged()
        proof_path = ATTESTATIONS / operation_id / name
        if name in ('guard-before.json', 'guard-after.json'):
            need(valid_id(self.lock_lease_id), 'current_lock_lease_unavailable')
            proof_path = ATTESTATIONS / operation_id / 'leases' / self.lock_lease_id / name
        value = sealed_json(proof_path)
        now, seen, expiry = self.clock(), value.get('observed_at'), value.get('expires_at')
        need(type(seen) in (int, float) and type(expiry) in (int, float)
             and math.isfinite(seen) and math.isfinite(expiry)
             and 0 <= now - seen <= maximum_age and now < expiry
             and expiry <= self.engine_policy.get('expires_at', 0), 'attestation_expired_or_unknown_clock')
        need(value.get('root_policy_sha256') == self.root_policy_sha256
             and value.get('operation_id') == operation_id
             and value.get('producer') == 'sealed_nodered_admin_validator', 'attestation_authority_unconfirmed')
        return value

    def validate(self, plan):
        value = self._proof(plan['operation_id'], 'validation.json', 900)
        need(value.get('plan_sha256') == digest(plan)
             and value.get('policy_sha256') == digest(self.engine_policy)
             and value.get('risk_sha256') == digest(plan['risk']), 'validation_attestation_binding_changed')
        fields = ('syntax', 'graph', 'layout', 'observability', 'isolated_regression',
                  'installed_node_types', 'canonical_sources_reconciled')
        need(all(value.get(k) is True for k in fields), 'validation_attestation_incomplete')
        return {'plan_sha256': digest(plan), **{k: True for k in fields}}

    def check_effect_review(self, binding, value):
        effect=value.get('effect_review')
        exact(effect,('device_tests','sensitive_effects','startup_effects'),'exact_effect_review_required')
        need(all(type(effect[k])is list and len(effect[k])<=128 for k in effect),'effect_review_scope_refused')
        need(effect['device_tests']==[], 'device_testing_not_in_administration_scope')
        if effect['sensitive_effects']:
            reference=value.get('owner_effect_approval_id')
            need(valid_id(reference),'specific_owner_effect_confirmation_required')
            owner=sealed_json(STATE/'owner-effect-approvals'/(reference+'.json'))
            need(owner.get('source')=='specific_owner_sensitive_effect_approval'
                 and owner.get('owner_specific_confirmation')is True
                 and owner.get('plan_sha256')==binding['plan_sha256']
                 and owner.get('policy_sha256')==binding['policy_sha256']
                 and owner.get('risk_sha256')==binding['risk_sha256']
                 and owner.get('effect_review_sha256')==digest(effect)
                 and type(owner.get('expires_at'))in(int,float)
                 and self.clock()<owner['expires_at']<=self.engine_policy['expires_at'],
                 'specific_owner_effect_confirmation_unconfirmed')
        return True

    def admit(self, binding, approval_id):
        need(valid_id(approval_id), 'approval_reference_required')
        value = self._proof(binding['operation_id'], 'admission.json', 900)
        need(value.get('approval_id') == approval_id and
             all(value.get(k) == v for k, v in binding.items()) and
             value.get('policy_activation_confirmed') is True and
             value.get('interface_confirmation_preserved') is True and
             value.get('reviewed_startup_and_sensitive_effects') is True,
             'exact_operation_admission_missing')
        self.check_effect_review(binding,value)
        need(not self.revoked() and self.engine_policy.get('enabled') is True
             and self.engine_policy.get('activation_confirmed') is True, 'administrative_policy_closed')
        # Resource verdicts are current local observations, not client booleans.
        memory = {line.split(':', 1)[0]: int(line.split()[1]) * 1024
                  for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:')}
        disk = os.statvfs('/mnt/data/docker')
        free_ratio = disk.f_bavail / disk.f_blocks if disk.f_blocks else 0
        need(memory.get('MemAvailable', 0) >= 2 * 1024 ** 3 and free_ratio >= .15,
             'host_resources_unavailable')
        self._native_guard_ready()
        self._inline_guard.produce_coordination(binding, self._lease_context())
        self._coordination_proof(binding)
        return {**binding, 'approval_id': approval_id,
                'policy_activation_confirmed': True, 'interface_confirmation_preserved': True,
                'reviewed_startup_and_sensitive_effects': True,
                'resources_available': True, 'shared_locks_held': self.locked,
                'expires_at': value['expires_at']}

    def _coordination_proof(self, binding):
        # Timestamp freshness alone cannot close the ledger-check TOCTOU.
        # The future native producer must inspect ledgers while holding the
        # inherited shared-lock descriptors for THIS unpredictable lease.
        need(self.locked and valid_id(self.lock_lease_id), 'current_lock_lease_unavailable')
        path = ATTESTATIONS / binding['operation_id'] / 'leases' / self.lock_lease_id / 'coordination.json'
        gate = sealed_json(path)
        need(gate.get('root_policy_sha256') == self.root_policy_sha256
             and gate.get('plan_sha256') == binding['plan_sha256']
             and gate.get('lock_lease_id') == self.lock_lease_id
             and gate.get('executing_pid') == os.getpid()
             and gate.get('producer') == 'sealed_nodered_admin_validator'
             and gate.get('ledgers_checked_under_inherited_shared_locks') is True
             and gate.get('global_no_unrelated_busy_or_uncertain_work') is True
             and type(gate.get('observed_at')) in (int, float)
             and self.locks_acquired_at <= gate['observed_at'] <= self.clock()
             and self.clock() - gate['observed_at'] <= 5,
             'cross_catalogue_coordination_unconfirmed')
        return True

    def _lease_context(self):
        need(self.locked and valid_id(self.lock_lease_id) and len(self._held_lock_fds) == 5,
             'current_inherited_lock_lease_unavailable')
        return {'lock_lease_id': self.lock_lease_id, 'executing_pid': os.getpid(),
                'locks_acquired_at': self.locks_acquired_at,
                'lock_identities': copy.deepcopy(self.document['shared_locks']),
                'lock_fds': self._held_lock_fds}

    def _make_native_guard(self, source_sha256):
        # Only bootstrap's exact verified bytes may construct this producer.
        # Caller arguments cannot supply a module, factory, path or readiness.
        code = ROOT / 'native_guard.py'
        need(hashlib.sha256(checked_read(code, 0o644, 1048576)).hexdigest() == source_sha256,
             'native_guard_producer_source_changed')
        module = sys.modules.get('native_guard')
        need(module is not None and getattr(module, '__file__', None) == str(code)
             and getattr(module, '__verified_source_sha256__', None) == source_sha256,
             'native_guard_producer_not_loaded_by_pinned_bootstrap')
        need(callable(getattr(module, 'NativeGuard', None)), 'native_guard_factory_unavailable')
        return module.NativeGuard(copy.deepcopy(self.document), self.root_policy_sha256, self.clock)

    def _native_guard_ready(self):
        expected = self.document.get('native_guard_producer')
        need(type(expected) is dict and expected.get('mode') == 'inline',
             'native_post_guard_producer_unavailable')
        source_sha = expected.get('source_sha256')
        need(valid_id(source_sha, SHA) and self.document['sources'].get('native_guard.py') == source_sha,
             'native_guard_producer_policy_pin_changed')
        if self._inline_guard is None:
            self._inline_guard = self._make_native_guard(source_sha)
        need(self._inline_guard.ready(self._lease_context()) is True,
             'native_post_guard_producer_unavailable')
        return True

    def guard(self, plan, phase='before'):
        need(phase in ('before', 'after'), 'guard_phase_refused')
        self._native_guard_ready()  # Missing producer blocks BEFORE any POST /flows.
        self._inline_guard.produce_guard(plan, phase, self._lease_context())
        value = self._proof(plan['operation_id'], 'guard-' + phase + '.json', 5)
        need(value.get('plan_sha256') == digest(plan)
             and value.get('policy_sha256') == digest(self.engine_policy)
             and value.get('risk_sha256') == digest(plan['risk'])
             and value.get('phase') == phase
             and value.get('lock_lease_id') == self.lock_lease_id
             and value.get('executing_pid') == os.getpid(), 'protected_state_attestation_binding_changed')
        if phase == 'after':
            intent = sealed_json(JOURNAL / plan['operation_id'] / 'intent.json')
            need(intent.get('plan_sha256') == digest(plan)
                 and value['observed_at'] >= intent.get('attempted_at', float('inf')),
                 'post_guard_predates_deploy_intent')
        need(value.get('credentials_unchanged') is True
             and value.get('context_preservation_proven') is True, 'protected_state_not_proven')
        fields = ('plan_sha256', 'phase', 'credentials_unchanged', 'context_preservation_proven',
                  'logical_delete_restore_isolated_proven', 'new_node_retirement_recoverable')
        return {k: value[k] for k in fields if k in value}

    def project_value(self, node_id, key, value):
        # This is a Root-provenance reader, never a client "public" switch.
        # Publication/Git verification belongs to a separately pinned generic
        # Root validator. Missing publisher/catalogue keeps values opaque.
        lease = self.lock_lease_id
        if getattr(self, '_catalog_for_lease', None) != lease:
            self._catalog_for_lease = lease
            self._catalog_values = {}
            self._catalog_evidence = {}
            try:
                need(self.locked and valid_id(lease), 'public_catalogue_requires_current_lock_lease')
                self._unchanged()
                self._native_guard_ready()
                settings = self.document['native_guard_producer'].get('public_source_catalog_producer')
                need(type(settings) is dict, 'public_source_catalogue_producer_unavailable')
                exact(settings, ('source_sha256',))
                source_sha = settings['source_sha256']
                need(valid_id(source_sha, SHA) and hashlib.sha256(checked_read(
                    ROOT / 'public_source_validator.py', 0o644, 1048576)).hexdigest() == source_sha,
                    'public_source_catalogue_producer_pin_changed')
                catalogue = decode(checked_read(STATE / 'public-source-catalog.json', 0o600, 8 * 1048576))
                exact(catalogue, ('schema_version', 'root_policy_sha256', 'producer',
                                 'producer_source_sha256', 'observed_at', 'expires_at', 'entries'))
                now, seen, expiry = self.clock(), catalogue['observed_at'], catalogue['expires_at']
                need(catalogue['schema_version'] == 1
                     and catalogue['root_policy_sha256'] == self.root_policy_sha256
                     and catalogue['producer'] == 'sealed_nodered_admin_public_source_validator'
                     and catalogue['producer_source_sha256'] == source_sha
                     and type(seen) in (int, float) and type(expiry) in (int, float)
                     and math.isfinite(seen) and math.isfinite(expiry)
                     and 0 <= now - seen <= 86400 and now < expiry <= self.engine_policy['expires_at']
                     and type(catalogue['entries']) is list and len(catalogue['entries']) <= 10000,
                     'public_source_catalogue_authority_unconfirmed')
                proven = {}
                evidence_rows = {}
                for row in catalogue['entries']:
                    exact(row, ('node_id', 'field', 'value_sha256', 'value', 'evidence'))
                    evidence = row['evidence']
                    exact(evidence, ('git_commit', 'git_blob', 'public_artifact_sha256',
                                     'reviewed_artifact_sha256', 'field_value_sha256',
                                     'public_review_id', 'public_source_review_passed'))
                    need(type(row['node_id']) is str and len(row['node_id']) <= 128
                         and type(row['field']) is str and 0 < len(row['field']) <= 128
                         and valid_id(row['value_sha256'], SHA)
                         and digest(row['value']) == row['value_sha256']
                         and evidence['field_value_sha256'] == row['value_sha256']
                         and type(evidence['git_commit']) is str and len(evidence['git_commit']) == 40
                         and all(c in '0123456789abcdef' for c in evidence['git_commit'])
                         and type(evidence['git_blob']) is str and len(evidence['git_blob']) == 40
                         and all(c in '0123456789abcdef' for c in evidence['git_blob'])
                         and valid_id(evidence['public_artifact_sha256'], SHA)
                         and valid_id(evidence['reviewed_artifact_sha256'], SHA)
                         and valid_id(evidence['public_review_id'])
                         and evidence['public_source_review_passed'] is True,
                         'public_source_catalogue_evidence_unconfirmed')
                    identity = (row['node_id'], row['field'], row['value_sha256'])
                    need(identity not in proven, 'duplicate_public_source_catalogue_entry')
                    proven[identity] = copy.deepcopy(row['value'])
                    evidence_rows[identity] = copy.deepcopy(evidence)
                self._catalog_values = proven
                self._catalog_evidence = evidence_rows
            except (ValueError, OSError, KeyError, TypeError):
                # A broken proof never suppresses otherwise permitted metadata.
                self._catalog_values = {}
        identity = (node_id, key, digest(value))
        if identity not in self._catalog_values:
            return None
        try:
            evidence = self._catalog_evidence[identity]
            review_raw = checked_read(STATE / 'public-source-reviews' /
                                      (evidence['public_review_id'] + '.json'), 0o600, 32768)
            need(hashlib.sha256(review_raw).hexdigest() == evidence['reviewed_artifact_sha256'],
                 'public_source_review_artifact_changed')
            review = decode(review_raw)
            exact(review, ('schema_version', 'root_policy_sha256', 'producer',
                           'producer_source_sha256', 'review_id', 'observed_at', 'expires_at',
                           'git_commit', 'git_blob', 'public_artifact_sha256',
                           'field_value_sha256', 'public_source_review_passed'))
            settings = self.document['native_guard_producer']['public_source_catalog_producer']
            need(review['schema_version'] == 1
                 and review['root_policy_sha256'] == self.root_policy_sha256
                 and review['producer'] == 'sealed_nodered_admin_public_source_validator'
                 and review['producer_source_sha256'] == settings['source_sha256']
                 and review['review_id'] == evidence['public_review_id']
                 and review['public_source_review_passed'] is True
                 and all(review[key] == evidence[key] for key in
                         ('git_commit', 'git_blob', 'public_artifact_sha256', 'field_value_sha256'))
                 and type(review['observed_at']) in (int, float)
                 and type(review['expires_at']) in (int, float)
                 and 0 <= self.clock() - review['observed_at'] <= 86400
                 and self.clock() < review['expires_at'] <= self.engine_policy['expires_at'],
                 'public_source_review_artifact_unconfirmed')
        except (ValueError, OSError, KeyError, TypeError):
            return None
        return {'source': 'exact_reviewed_public_source', 'value_sha256': digest(value),
                'value': copy.deepcopy(self._catalog_values[identity])}

    def peer_check(self):
        # FixedTransport invokes this immediately before EVERY HTTP request,
        # including /auth/token and /auth/revoke. No manual/static peer fallback.
        if self.locked:
            return self._peer_check_locked()
        with self.locks():
            return self._peer_check_locked()

    def _peer_check_locked(self):
        self._unchanged()
        self._native_guard_ready()
        result = self._inline_guard.produce_peer(self._lease_context())
        exact(result, ('proof_path','proof_sha256','request_generation'))
        nonce = result['request_generation']
        need(valid_id(nonce) and valid_id(result['proof_sha256'], SHA), 'peer_generation_unconfirmed')
        proof_path = ATTESTATIONS / 'peer' / self.lock_lease_id / (nonce + '.json')
        need(result['proof_path'] == str(proof_path), 'peer_proof_path_outside_current_lease')
        body = checked_read(proof_path)
        value = decode(body)
        need(type(value) is dict and digest(value) == result['proof_sha256'], 'peer_proof_digest_changed')
        backend = self.document['backend']
        now, seen, expiry = self.clock(), value.get('observed_at'), value.get('expires_at')
        need(value.get('schema_version') == 1
             and value.get('producer') == 'sealed_nodered_admin_inline_peer'
             and value.get('root_policy_sha256') == self.root_policy_sha256
             and value.get('loaded_source_sha256') == self.document['sources']['native_guard.py']
             and value.get('runtime_activation_sha256') == self.document['native_guard_producer']['runtime_activation_sha256']
             and value.get('backend_identity_sha256') == backend['identity_sha256']
             and value.get('host') == backend['host'] and value.get('port') == 1880
             and value.get('request_generation') == nonce
             and value.get('lock_lease_id') == self.lock_lease_id
             and value.get('executing_pid') == os.getpid()
             and value.get('backend_listener_identity_proven') is True
             and value.get('authenticated_Admin_API_enabled') is None
             and value.get('authentication_proven') is False
             and type(seen) in (int,float) and type(expiry) in (int,float)
             and math.isfinite(seen) and math.isfinite(expiry)
             and self.locks_acquired_at <= seen <= now and 0 <= now-seen <= 5
             and now < expiry <= seen+5, 'current_backend_peer_unconfirmed')
        return True
