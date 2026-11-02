"""Uninstalled Node-RED administration candidate. No network/CLI/credentials.

Production must supply a sealed transport, trusted validator/admission and the
existing shared-lock coordinator. Passing synthetic adapters proves only model
behaviour. No caller-selected paths, commands, URLs, deploy types or policy.
"""
import copy
import difflib
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import time

OP = re.compile(r'[a-f0-9]{32}')
SHA = re.compile(r'[a-f0-9]{64}')
NODE = re.compile(r'[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}')
PROTECTED = re.compile(r'credential|password|passwd|secret|token|authorization|adminAuth', re.I)
FORBIDDEN_TYPES = {'exec', 'shell', 'daemon', 'file', 'file in', 'watch', 'tail',
                   'http in', 'tcp in', 'udp in', 'websocket-listener'}
MAX_BYTES = 8 * 1024 * 1024
MAX_NODES = 10000
MAX_CHANGED = 128
MAX_STATE = 256 * 1024 * 1024
MAX_OPERATIONS = 64


def need(value, reason):
    if not value:
        raise ValueError(reason)


def raw(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False,
                      separators=(',', ':'), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(raw(value)).hexdigest()


def exact(value, fields, reason='request_scope_refused'):
    need(type(value) is dict and set(value) == set(fields), reason)


def valid_id(value, pattern=OP):
    return type(value) is str and pattern.fullmatch(value) is not None


def protected_input(value):
    if type(value) is dict:
        return any(PROTECTED.search(str(key)) or key in ('__proto__', 'prototype', 'constructor')
                   or protected_input(item) for key, item in value.items())
    if type(value) is list:
        return any(protected_input(item) for item in value)
    return False


def snapshot(value):
    exact(value, ('rev', 'flows'), 'snapshot_scope_refused')
    need(type(value['rev']) is str and 0 < len(value['rev']) <= 256
         and '\x00' not in value['rev'], 'revision_unconfirmed')
    flows = value['flows']
    need(type(flows) is list and len(flows) <= MAX_NODES
         and len(raw(flows)) <= MAX_BYTES, 'snapshot_bound')
    seen = set()
    for node in flows:
        need(type(node) is dict and valid_id(node.get('id'), NODE)
             and type(node.get('type')) is str and node['id'] not in seen,
             'node_identity_unconfirmed')
        need('credentials' not in node, 'raw_credentials_in_flow_snapshot')
        seen.add(node['id'])
    return copy.deepcopy(value)


def safe_value(key, value, node_id=None, projector=None):
    # No runtime value is returned by default. Heuristic sanitization cannot
    # prove a Function body or arbitrary node property contains no secret.
    if PROTECTED.search(key):
        return {'withheld': True, 'reason': 'credential_field', 'sha256': digest(value)}
    if callable(projector):
        proof = projector(node_id, key, copy.deepcopy(value))
        if (type(proof) is dict and proof.get('source') == 'exact_reviewed_public_source'
                and proof.get('value_sha256') == digest(value)
                and 'value' in proof and digest(proof['value']) == digest(value)
                and len(raw(proof['value'])) <= 65536):
            return {'source': proof['source'], 'value': copy.deepcopy(proof['value'])}
    return {'withheld': True, 'reason': 'no_reviewed_public_value_proof', 'sha256': digest(value)}


def node_projection(node, projector=None):
    return {'id': node['id'], 'type': node['type'], 'sha256': digest(node),
            'fields': {k: {'sha256': digest(v), 'value': safe_value(k, v, node['id'], projector)}
                       for k, v in node.items()}}


def changeset(before, after, projector=None):
    old = {n['id']: n for n in before}
    new = {n['id']: n for n in after}
    changes = []
    for identifier in sorted(old.keys() | new.keys()):
        a, b = old.get(identifier), new.get(identifier)
        if a == b:
            continue
        keys = sorted((a or {}).keys() | (b or {}).keys())
        fields = []
        for key in keys:
            if (key in (a or {}), (a or {}).get(key)) == (key in (b or {}), (b or {}).get(key)):
                continue
            av = safe_value(key, a[key], identifier, projector) if a and key in a else '<absent>'
            bv = safe_value(key, b[key], identifier, projector) if b and key in b else '<absent>'
            fields.append({'field': key, 'before_present': bool(a and key in a),
                           'after_present': bool(b and key in b),
                           'before_sha256': digest(a[key]) if a and key in a else None,
                           'after_sha256': digest(b[key]) if b and key in b else None,
                           'diff': ''.join(difflib.unified_diff(
                               json.dumps(av, indent=2, ensure_ascii=False).splitlines(True),
                               json.dumps(bv, indent=2, ensure_ascii=False).splitlines(True),
                               fromfile='before', tofile='after'))})
        changes.append({'node_id': identifier, 'before_sha256': digest(a) if a else None,
                        'after_sha256': digest(b) if b else None, 'fields': fields})
    return changes


def effect_inventory(before, after, diff):
    """Conservative review inventory, deliberately not a proof of no effects."""
    all_nodes = {n['id']: n for n in before + after}
    changed_ids = {r['node_id'] for r in diff}
    changed = [all_nodes[k] for k in changed_ids]
    reasons = set()
    for node in changed:
        kind = node['type']
        if kind == 'function':
            reasons.add('function_restart_and_old_callbacks')
            if node.get('initialize') or node.get('finalize'):
                reasons.add('function_initialize_or_finalize')
        if kind == 'inject' and (node.get('once') or node.get('repeat') or node.get('crontab')):
            reasons.add('inject_startup_or_timer')
        if kind in ('catch', 'status'):
            reasons.add('catch_or_status_event_on_deploy')
        if kind in ('mqtt in', 'mqtt out') or 'server' in node or 'broker' in node:
            reasons.add('connection_or_retained_message')
        if kind == 'tab' or kind.startswith('subflow:'):
            reasons.add('flow_or_subflow_lifecycle')
    affected_tabs = sorted({n.get('z') for n in changed if type(n.get('z')) is str})
    possible = [n['id'] for n in before + after if n.get('z') in affected_tabs]
    reasons.add('downstream_and_dynamic_dispatch_not_proven_safe')
    return {'changed_node_ids': sorted(changed_ids), 'affected_flow_ids': affected_tabs,
            'possible_downstream_node_ids': sorted(set(possible)),
            'reasons': sorted(reasons), 'startup_effects_unknown': True,
            'sensitive_actuator_effects_unknown': True,
            'removed_node_ids': sorted({n['id'] for n in before} - {n['id'] for n in after}),
            'automated_scan_is_authorization': False,
            'requires_exact_effect_review': True}


def build_plan(operation_id, base, edits, policy_sha256, now, ttl=900, projector=None):
    need(valid_id(operation_id) and valid_id(policy_sha256, SHA), 'invalid_identity')
    before = snapshot(base)
    need(type(edits) is list and 0 < len(edits) <= MAX_CHANGED and len(raw(edits)) <= 1048576, 'edit_bound')
    need(type(now) in (float, int) and math.isfinite(now)
         and type(ttl) is int and 1 <= ttl <= 900, 'plan_clock_or_ttl')
    flows = copy.deepcopy(before['flows'])
    index = {n['id']: n for n in flows}
    touched = set()
    deleted = []
    for edit in edits:
        need(type(edit) is dict and edit.get('kind') in ('create', 'patch', 'delete'), 'edit_kind_refused')
        kind = edit['kind']
        if kind == 'create':
            exact(edit, ('kind', 'node'))
            node = copy.deepcopy(edit['node'])
            snapshot({'rev': before['rev'], 'flows': [node]})
            need(node['id'] not in index, 'create_node_exists')
            need(node['type'] not in FORBIDDEN_TYPES, 'shell_node_refused')
            need(not protected_input(node), 'protected_field_refused')
            need(not node.get('libs'), 'module_install_not_admitted')
            flows.append(node)
            index[node['id']] = node
            identifier = node['id']
        else:
            expected = ('kind', 'node_id', 'expected_node_sha256', 'set_fields', 'unset_fields') if kind == 'patch' else ('kind', 'node_id', 'expected_node_sha256')
            exact(edit, expected)
            identifier = edit['node_id']
            need(valid_id(identifier, NODE) and identifier in index, 'node_missing')
            node = index[identifier]
            need(valid_id(edit['expected_node_sha256'], SHA)
                 and digest(node) == edit['expected_node_sha256'], 'node_compare_swap_conflict')
            need(node['type'] not in FORBIDDEN_TYPES, 'shell_node_refused')
            if kind == 'patch':
                fields, remove = edit['set_fields'], edit['unset_fields']
                need(type(fields) is dict and type(remove) is list
                     and all(type(k) is str for k in remove) and len(set(remove)) == len(remove)
                     and not set(fields) & set(remove), 'field_edit_scope')
                keys = set(fields) | set(remove)
                need(not protected_input(fields), 'protected_field_refused')
                need(keys and not any(k in ('id', 'type') or PROTECTED.search(k) for k in keys), 'protected_field_refused')
                need('libs' not in keys, 'module_install_not_admitted')
                for key in remove:
                    need(key in node, 'unset_field_missing')
                    del node[key]
                node.update(copy.deepcopy(fields))
            else:
                # Configuration nodes have no reliable generic disable effect.
                # Keep them unchanged until a separately proven retirement path.
                need(node['type'] == 'tab' or valid_id(node.get('z'), NODE),
                     'configuration_node_quarantine_unavailable')
                # Recovery-preserving logical deletion: no removal from config,
                # no credential pruning, no context rewind or arbitrary paths.
                node['disabled' if node['type'] == 'tab' else 'd'] = True
                deleted.append(identifier)
        need(identifier not in touched, 'duplicate_node_edit')
        touched.add(identifier)
    after = snapshot({'rev': before['rev'], 'flows': flows})
    diff = changeset(before['flows'], after['flows'], projector)
    need(diff and len(diff) <= MAX_CHANGED and len(raw(diff)) <= 1048576, 'empty_or_oversized_delta')
    # Whole-array order and every unaffected field are preserved by construction.
    return {'schema_version': 1, 'host': 'raspberry', 'operation_id': operation_id,
            'policy_sha256': policy_sha256, 'created_at': now, 'expires_at': now + ttl,
            'action': 'apply', 'parent_operation_id': None,
            'before_revision': before['rev'], 'before_sha256': digest(before['flows']),
            'after_sha256': digest(after['flows']), 'before_flows': before['flows'],
            'after_flows': after['flows'], 'edits_sha256': digest(edits),
            'diff': diff, 'deleted_logically': deleted, 'retired_created_nodes': [],
            'hard_delete_enabled': False,
            'deploy_type': 'nodes', 'risk': effect_inventory(before['flows'], after['flows'], diff),
            'functional_recovery_proven': False}


def public_plan(plan):
    fields = ('schema_version', 'host', 'operation_id', 'policy_sha256', 'action',
              'parent_operation_id', 'created_at', 'expires_at', 'before_revision',
              'before_sha256', 'after_sha256', 'diff', 'deleted_logically', 'retired_created_nodes',
              'hard_delete_enabled', 'deploy_type', 'risk', 'functional_recovery_proven')
    return {**{k: copy.deepcopy(plan[k]) for k in fields}, 'plan_sha256': digest(plan),
            'source': 'uninstalled_nodered_admin_candidate', 'automatic_retry': False}


class Journal:
    """Private append-only phase files, constructor path fixed by sealed service."""
    NAMES = {'plan.json', 'validation.json', 'intent.json', 'receipt.json'}

    def __init__(self, directory):
        self.directory = Path(directory).absolute()
        self._directory(self.directory)

    @staticmethod
    def _directory(path):
        for parent in (path, *path.parents):
            info = parent.lstat()
            need(not stat.S_ISLNK(info.st_mode) and stat.S_ISDIR(info.st_mode), 'symlink_directory_refused')
        s = path.stat()
        need(s.st_uid == os.geteuid() and stat.S_IMODE(s.st_mode) == 0o700, 'unsafe_private_directory')

    def folder(self, operation_id):
        need(valid_id(operation_id), 'invalid_operation_id')
        return self.directory / operation_id

    @staticmethod
    def _sync(path):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def _read(self, path):
        self._directory(path.parent)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            s = os.fstat(fd)
            need(stat.S_ISREG(s.st_mode) and s.st_uid == os.geteuid()
                 and stat.S_IMODE(s.st_mode) == 0o600 and s.st_nlink == 1
                 and s.st_size <= 2 * MAX_BYTES + 262144, 'unsafe_journal_file')
            body = os.read(fd, 2 * MAX_BYTES + 262145)
            need(len(body) == s.st_size, 'journal_changed_during_read')
            return json.loads(body)
        finally:
            os.close(fd)

    def read(self, operation_id, name):
        need(name in self.NAMES, 'journal_name_refused')
        path = self.folder(operation_id) / name
        if not os.path.lexists(path):
            return None
        return self._read(path)

    def _create(self, path, value):
        body = raw(value) + b'\n'
        need(len(body) <= 2 * MAX_BYTES + 262144, 'journal_file_bound')
        self._directory(path.parent)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, 'wb', closefd=False) as stream:
                stream.write(body)
                stream.flush()
                os.fsync(fd)
        finally:
            os.close(fd)
        self._sync(path.parent)

    def register(self, plan):
        operation_id = plan['operation_id']
        existing = self.read(operation_id, 'plan.json')
        if existing is not None:
            need(digest(existing) == digest(plan), 'operation_id_conflict')
            return False
        entries = list(self.directory.iterdir())
        need(len(entries) < MAX_OPERATIONS, 'journal_operation_bound')
        size = 0
        for folder in entries:
            need(valid_id(folder.name), 'unexpected_journal_entry')
            self._directory(folder)
            for file in folder.iterdir():
                need(file.name in self.NAMES, 'unexpected_journal_file')
                self._read(file)
                size += file.stat().st_size
        need(size + len(raw(plan)) + 262144 <= MAX_STATE, 'journal_capacity')
        folder = self.folder(operation_id)
        os.mkdir(folder, 0o700)
        self._sync(self.directory)
        self._create(folder / 'plan.json', plan)
        return True

    def write(self, operation_id, name, value):
        need(name in self.NAMES and name != 'plan.json', 'journal_name_refused')
        self._create(self.folder(operation_id) / name, value)

    def uncertain_operations(self):
        result = []
        for folder in self.directory.iterdir():
            need(valid_id(folder.name), 'unexpected_journal_entry')
            self._directory(folder)
            intent = self.read(folder.name, 'intent.json')
            receipt = self.read(folder.name, 'receipt.json')
            if intent and (not receipt or receipt.get('state') == 'uncertain'):
                result.append(folder.name)
        return result

    def attempts(self, since):
        rows = []
        for folder in self.directory.iterdir():
            intent = self.read(folder.name, 'intent.json')
            if intent and intent.get('attempted_at', 0) >= since:
                rows.append(intent)
        return rows


class Engine:
    """Transport contract: fetch()->{rev,flows}; deploy(rev,flows) with fixed nodes/v2.

    Coordination is a trusted internal adapter, never an MCP argument. It must
    provide locks(), revoked(), validate(plan), admit(binding,approval_id),
    guard(plan,phase=before|after). guard proves credential/context preservation for the exact
    changed node set before invoking any runtime API write.
    """
    def __init__(self, policy, transport, journal, coordination, clock=time.time):
        self.policy = copy.deepcopy(policy)
        self.transport, self.journal, self.coordination, self.clock = transport, journal, coordination, clock
        need(all(callable(getattr(coordination, k, None)) for k in
                 ('locks', 'revoked', 'validate', 'admit', 'guard')), 'sealed_coordination_unavailable')
        need(callable(getattr(transport, 'fetch', None)) and callable(getattr(transport, 'deploy', None)), 'sealed_transport_unavailable')

    def _policy(self, effect=False):
        p = self.policy
        need(p.get('enabled') is True and p.get('host') == 'raspberry'
             and p.get('project') == '/mnt/data/docker'
             and p.get('activation_confirmed') is True, 'policy_not_activated')
        need(self.coordination.revoked() is False, 'policy_revoked')
        need(type(p.get('expires_at')) in (int, float) and math.isfinite(p['expires_at'])
             and self.clock() + (90 if effect else 0) < p['expires_at'], 'policy_expired_or_completion_margin')
        need(p.get('maximum_deploys_per_24h') == 4 and p.get('minimum_deploy_spacing_seconds') == 60
             and p.get('maximum_plan_age_seconds') == 900, 'policy_limits_changed')
        return digest(p)

    def _plan(self, operation_id):
        value = self.journal.read(operation_id, 'plan.json')
        need(type(value) is dict and value['operation_id'] == operation_id, 'prepared_plan_missing')
        need(value['policy_sha256'] == self._policy(), 'prepared_policy_changed')
        return value

    def read(self):
        with self.coordination.locks():
            self._policy()
            value = snapshot(self.transport.fetch())
            return {'source': 'fixed_NodeRED_Admin_API_v2', 'observed_at': self.clock(),
                    'age_seconds': 0, 'collection_error': None, 'revision': value['rev'],
                    'sha256': digest(value['flows']), 'nodes': [node_projection(n, getattr(self.coordination, 'project_value', None)) for n in value['flows']],
                    'coverage': ['bounded_current_configuration', 'not_credentials_or_runtime_context',
                                 'not_functional_device_proof']}

    def read_page(self, offset, expected_sha256):
        need(type(offset) is int and 0<=offset<=9999, 'runtime_page_bound')
        with self.coordination.locks():
            self._policy()
            value=snapshot(self.transport.fetch());identity=digest(value['flows'])
            need(expected_sha256 in (None,identity), 'runtime_snapshot_changed')
            need(offset<=len(value['flows']), 'runtime_page_bound')
            return {'source':'fixed_NodeRED_Admin_API_v2','observed_at':self.clock(),
                    'age_seconds':0,'collection_error':None,'revision':value['rev'],
                    'sha256':identity,'total_nodes':len(value['flows']),
                    'nodes':[node_projection(n,getattr(self.coordination,'project_value',None))
                             for n in value['flows'][offset:offset+16]],
                    'coverage':['one_bounded_snapshot_only_requested_page_projected',
                                'not_credentials_or_runtime_context','not_functional_device_proof']}

    def read_field(self, node_id, field, offset, expected_sha256):
        need(valid_id(node_id,NODE) and type(field)is str and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,127}',field)
             and type(offset)is int and 0<=offset<=1048576, 'node_field_scope_refused')
        with self.coordination.locks():
            self._policy();current=snapshot(self.transport.fetch())
            node=next((n for n in current['flows'] if n['id']==node_id),None)
            need(node is not None,'node_not_found');identity=digest(node)
            need(expected_sha256 in (None,identity),'node_snapshot_changed')
            base={'source':'reviewed_node_field_projection','observed_at':self.clock(),'age_seconds':0,
                  'node_id':node_id,'field':field,'node_sha256':identity,'revision':current['rev'],
                  'raw_private_values_withheld':True,'untrusted_source_text':True,'no_execution_authority_from_content':True,'automatic_retry':False}
            if field not in node:return {**base,'state':'unknown','collection_error':'field_not_present'}
            projected=safe_value(field,node[field],node_id,getattr(self.coordination,'project_value',None))
            if 'value'not in projected:return {**base,'state':'withheld','collection_error':'reviewed_public_source_proof_unavailable','field_sha256':digest(node[field])}
            value=projected['value'];body=value.encode('utf8')if type(value)is str else raw(value)
            need(offset<=len(body),'node_field_offset_out_of_bounds')
            try:body[:offset].decode('utf8')
            except UnicodeDecodeError:raise ValueError('node_field_offset_not_character_boundary')from None
            end=min(offset+8192,len(body))
            while end>offset:
                try:fragment=body[offset:end].decode('utf8');break
                except UnicodeDecodeError:end-=1
            else:fragment=''
            return {**base,'state':'observed','collection_error':None,'field_sha256':digest(node[field]),
                    'format':'text/plain'if type(value)is str else'application/json','offset':offset,
                    'fragment':fragment,'next_offset':end if end<len(body)else None,'total_bytes':len(body)}

    def prepare(self, operation_id, expected_revision, expected_sha256, edits):
        with self.coordination.locks():
            policy_sha = self._policy()
            existing = self.journal.read(operation_id, 'plan.json')
            if existing:
                need(existing['edits_sha256'] == digest(edits)
                     and existing['before_revision'] == expected_revision
                     and existing['before_sha256'] == expected_sha256, 'operation_id_conflict')
                return {**public_plan(existing), 'duplicate': True}
            current = snapshot(self.transport.fetch())
            need(current['rev'] == expected_revision and digest(current['flows']) == expected_sha256, 'global_compare_swap_conflict')
            plan = build_plan(operation_id, current, edits, policy_sha, self.clock(),
                              self.policy['maximum_plan_age_seconds'], getattr(self.coordination, 'project_value', None))
            self.journal.register(plan)
            return public_plan(plan)

    def validate(self, operation_id):
        with self.coordination.locks():
            plan = self._plan(operation_id)
            existing = self.journal.read(operation_id, 'validation.json')
            if existing:
                need(existing['plan_sha256'] == digest(plan), 'validation_binding_changed')
                return existing
            proof = self.coordination.validate(copy.deepcopy(plan))
            required = ('syntax', 'graph', 'layout', 'observability', 'isolated_regression',
                        'installed_node_types', 'canonical_sources_reconciled')
            need(type(proof) is dict and proof.get('plan_sha256') == digest(plan)
                 and all(proof.get(k) is True for k in required), 'validation_unconfirmed')
            value = {'plan_sha256': digest(plan), 'validated_at': self.clock(),
                     **{k: True for k in required}, 'functional_recovery_proven': False}
            self.journal.write(operation_id, 'validation.json', value)
            return value

    def _guard(self, plan, phase):
        need(phase in ('before', 'after'), 'protected_state_guard_phase_refused')
        guard = self.coordination.guard(copy.deepcopy(plan), phase=phase)
        need(type(guard) is dict and guard.get('plan_sha256') == digest(plan)
             and guard.get('phase') == phase and guard.get('credentials_unchanged') is True
             and guard.get('context_preservation_proven') is True,
             'credential_or_context_protection_unconfirmed')
        if plan['deleted_logically']:
            need(guard.get('logical_delete_restore_isolated_proven') is True, 'recoverable_delete_not_proven')
        if plan['risk'].get('removed_node_ids'):
            need(guard.get('new_node_retirement_recoverable') is True, 'own_created_node_context_recovery_unproven')
        # Persist only proof hash and verdicts, never protected state values.
        return digest(guard)

    def _preflight(self, plan, approval_id):
        self._policy(effect=True)
        need(self.clock() < plan['expires_at'], 'prepared_plan_expired')
        need(not self.journal.uncertain_operations(), 'prior_uncertain_deploy_requires_reconciliation')
        validated = self.journal.read(plan['operation_id'], 'validation.json')
        need(validated and validated.get('plan_sha256') == digest(plan), 'validation_required')
        current = snapshot(self.transport.fetch())
        need(current['rev'] == plan['before_revision']
             and digest(current['flows']) == plan['before_sha256'], 'global_compare_swap_conflict')
        attempts = self.journal.attempts(self.clock() - 86400)
        need(len(attempts) < self.policy['maximum_deploys_per_24h'], 'daily_deploy_budget')
        need(not attempts or self.clock() - max(a['attempted_at'] for a in attempts) >= 60, 'deploy_spacing')
        need(valid_id(approval_id), 'exact_approval_reference_required')
        binding = {'operation_id': plan['operation_id'], 'plan_sha256': digest(plan),
                   'policy_sha256': plan['policy_sha256'], 'action': plan['action'],
                   'risk_sha256': digest(plan['risk']), 'deploy_type': 'nodes',
                   'before_revision': plan['before_revision'], 'before_sha256': plan['before_sha256'],
                   'after_sha256': plan['after_sha256']}
        gate = self.coordination.admit(binding, approval_id)
        need(type(gate) is dict and all(gate.get(k) == v for k, v in binding.items()), 'operation_admission_unconfirmed')
        need(gate.get('approval_id') == approval_id and gate.get('policy_activation_confirmed') is True
             and gate.get('interface_confirmation_preserved') is True
             and gate.get('reviewed_startup_and_sensitive_effects') is True
             and gate.get('resources_available') is True and gate.get('shared_locks_held') is True
             and self.clock() + 90 < gate.get('expires_at', 0), 'exact_effect_admission_required')
        before_guard_sha256 = self._guard(plan, 'before')
        return {'state': 'preflight_passed_not_applied', **binding,
                'observed_at': self.clock(), 'collection_error': None,
                'credential_and_context_guard': True, 'guard_before_sha256': before_guard_sha256,
                'automatic_retry': False}

    def preflight(self, operation_id, approval_id):
        with self.coordination.locks():
            return self._preflight(self._plan(operation_id), approval_id)

    def apply(self, operation_id, plan_sha256, approval_id):
        with self.coordination.locks():
            plan = self._plan(operation_id)
            need(plan_sha256 == digest(plan), 'exact_plan_hash_required')
            existing = self.journal.read(operation_id, 'receipt.json')
            if existing:
                return {**existing, 'duplicate': True}
            if self.journal.read(operation_id, 'intent.json'):
                return {'operation_id': operation_id, 'state': 'uncertain',
                        'collection_error': 'existing_deploy_intent_no_retry', 'automatic_retry': False}
            preflight = self._preflight(plan, approval_id)
            # Completion of this fsync precedes the only write RPC. Crashes or
            # response loss leave a durable uncertain intent, never a replay.
            self.journal.write(operation_id, 'intent.json', {'operation_id': operation_id,
                'plan_sha256': plan_sha256, 'action': plan['action'], 'attempted_at': self.clock(),
                'expected_revision': plan['before_revision'], 'automatic_retry': False})
            receipt = {'operation_id': operation_id, 'plan_sha256': plan_sha256,
                       'before_sha256': plan['before_sha256'], 'after_sha256': plan['after_sha256'],
                       'action': plan['action'], 'state': 'uncertain', 'after_revision': None,
                       'collection_error': 'deploy_outcome_unconfirmed', 'automatic_retry': False,
                       'functional_recovery_proven': False, 'effect_attempted': True,
                       'guard_before_sha256': preflight['guard_before_sha256'],
                       'guard_after_sha256': None, 'credentials_preservation_verified': False,
                       'context_preservation_verified': False}
            try:
                reply = self.transport.deploy(plan['before_revision'], copy.deepcopy(plan['after_flows']))
                if reply.get('state') == 'conflict' and reply.get('effect_proven_absent') is True:
                    receipt.update(state='rejected_without_effect', collection_error='revision_conflict',
                                   definitive_no_effect=True)
                elif reply.get('state') == 'accepted':
                    revision = reply.get('rev')
                    need(type(revision) is str and 0 < len(revision) <= 512, 'deploy_revision_unconfirmed')
                    loaded = snapshot(self.transport.fetch())
                    need(loaded['rev'] == revision and digest(loaded['flows']) == plan['after_sha256'],
                         'loaded_configuration_unconfirmed')
                    receipt['collection_error'] = 'credential_or_context_after_unconfirmed'
                    after_guard_sha256 = self._guard(plan, 'after')
                    receipt.update(state='applied', after_revision=revision, collection_error=None,
                                   loaded_configuration_verified=True,
                                   guard_after_sha256=after_guard_sha256,
                                   credentials_preservation_verified=True,
                                   context_preservation_verified=True)
            except Exception:
                # Never export exception text, request body, authentication or logs.
                pass
            receipt['completed_at'] = self.clock()
            self.journal.write(operation_id, 'receipt.json', receipt)
            return receipt

    def status(self, operation_id):
        with self.coordination.locks():
            need(self.policy.get('host') == 'raspberry' and self.policy.get('project') == '/mnt/data/docker', 'policy_identity_changed')
            plan = self.journal.read(operation_id, 'plan.json')
            need(plan is not None, 'operation_missing')
            value = self.journal.read(operation_id, 'receipt.json')
            if value:
                return value
            return {'operation_id': operation_id,
                    'state': 'uncertain' if self.journal.read(operation_id, 'intent.json') else 'prepared',
                    'plan_sha256': digest(plan), 'automatic_retry': False,
                    'functional_recovery_proven': False}

    def verify(self, operation_id):
        with self.coordination.locks():
            self._policy()
            plan = self.journal.read(operation_id, 'plan.json')
            need(plan is not None, 'operation_missing')
            receipt = self.journal.read(operation_id, 'receipt.json')
            loaded = snapshot(self.transport.fetch())
            matches = digest(loaded['flows']) == plan['after_sha256']
            after_guard_sha256 = None
            try:
                after_guard_sha256 = self._guard(plan, 'after')
            except Exception:
                pass
            return {'operation_id': operation_id, 'source': 'fixed_NodeRED_Admin_API_v2',
                    'observed_at': self.clock(), 'age_seconds': 0,
                    'collection_error': None if after_guard_sha256 else 'credential_or_context_verification_unconfirmed',
                    'guard_after_sha256': after_guard_sha256,
                    'credentials_and_context_preserved': after_guard_sha256 is not None,
                    'loaded_after_sha256_matches': matches,
                    'own_applied_revision_matches': bool(receipt and receipt.get('state') == 'applied'
                                                       and receipt.get('after_revision') == loaded['rev']),
                    'uncertain_receipt_not_promoted_by_content_match': True,
                    'functional_recovery_proven': False, 'automatic_retry': False}

    def rollback(self, operation_id, rollback_operation_id):
        """Prepare own reverse plan. Apply requires separate exact admission.

        No merge/rebase: every current node/field and revision must still equal
        our verified afterimage. New third-party writes block, even if unrelated.
        """
        with self.coordination.locks():
            self._policy(effect=True)
            original = self.journal.read(operation_id, 'plan.json')
            receipt = self.journal.read(operation_id, 'receipt.json')
            need(original and receipt and original['action'] == 'apply'
                 and receipt.get('state') == 'applied', 'own_applied_result_required')
            current = snapshot(self.transport.fetch())
            need(current['rev'] == receipt['after_revision']
                 and digest(current['flows']) == original['after_sha256'], 'foreign_change_blocks_rollback')
            need(valid_id(rollback_operation_id) and rollback_operation_id != operation_id, 'rollback_identity_refused')
            original_ids = {node['id'] for node in original['before_flows']}
            restore = copy.deepcopy(original['before_flows'])
            retired = []
            for node in current['flows']:
                if node['id'] in original_ids:
                    continue
                # Retain newly created IDs and their data. A reverse-create is
                # logical retirement, never a physical context/credential prune.
                need(node['type'] == 'tab' or valid_id(node.get('z'), NODE),
                     'configuration_node_quarantine_unavailable')
                kept = copy.deepcopy(node)
                kept['disabled' if kept['type'] == 'tab' else 'd'] = True
                restore.append(kept)
                retired.append(kept['id'])
            snapshot({'rev': current['rev'], 'flows': restore})
            diff = changeset(current['flows'], restore, getattr(self.coordination, 'project_value', None))
            need(diff and len(diff) <= MAX_CHANGED and len(raw(diff)) <= 1048576,
                 'empty_or_oversized_delta')
            now = self.clock()
            plan = {**copy.deepcopy(original), 'operation_id': rollback_operation_id,
                    'action': 'rollback', 'parent_operation_id': operation_id,
                    'created_at': now, 'expires_at': now + 900,
                    'before_revision': current['rev'], 'before_sha256': original['after_sha256'],
                    'after_sha256': digest(restore), 'before_flows': current['flows'],
                    'after_flows': restore, 'diff': diff,
                    'retired_created_nodes': retired, 'deleted_logically': retired,
                    'hard_delete_enabled': False,
                    'risk': effect_inventory(current['flows'], restore, diff),
                    'edits_sha256': digest({'rollback_own': operation_id})}
            self.journal.register(plan)
            return public_plan(plan)
