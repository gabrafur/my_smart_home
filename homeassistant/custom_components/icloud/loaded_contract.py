"""Fixed in-process contract observation. No I/O, calls or provider properties."""
import asyncio
import datetime
import json
import math
import os
from pathlib import Path
import re
import stat
import time
import types

ROLES = ('resident_primary', 'resident_secondary')
FIELDS = ('handler_ready', 'binding_loaded', 'provider_is_icloud',
          'target_is_expected_icloud_update', 'location_target_contract_valid', 'downstream_registered',
          'matching_loaded_account', 'api_present')
ERRORS = frozenset(('observation_layout_unknown', 'ambiguous_loaded_account',
                    'binding_contract_invalid', 'scope_inactive'))
EXCEPTIONS = frozenset(('HomeAssistantError', 'ServiceNotFound',
                       'PyiCloudServiceUnavailable', 'PyiCloudServiceNotActivatedException',
                       'TimeoutError', 'ConnectionError', 'other'))


def unknown(error='observation_layout_unknown'):
    if type(error) is not str or error not in ERRORS:
        error = 'observation_layout_unknown'
    return {role: {**dict.fromkeys(FIELDS), 'collection_error': error}
            for role in ROLES}


def project(facts):
    """Only primitive allowlisted facts may cross the executor/proof boundary."""
    if type(facts) is not dict or set(facts) != set(ROLES):
        facts = unknown()
    result = []
    for role in ROLES:
        row = facts[role]
        if (type(row) is not dict or set(row) != {*FIELDS, 'collection_error'}
                or any(row[field] is not None and type(row[field]) is not bool
                       for field in FIELDS)
                or (row['collection_error'] is not None
                    and (type(row['collection_error']) is not str
                         or row['collection_error'] not in ERRORS))):
            row = unknown()[role]
        result.append({'role': role, 'action': 'refresh_location',
                       'state': 'unknown' if row['collection_error'] else 'observed',
                       **row})
    partial = any(row['collection_error'] for row in result)
    return {'schema_version': 1, 'source': 'HA_fixed_loaded_binding_contract',
            'state': 'unknown' if partial else 'observed',
            'collection_error': 'partial_collection_failure' if partial else None,
            'roles': result, 'functional_recovery_proven': False,
            'coverage': ['two_fixed_loaded_binding_roles', 'fixed_icloud_update_registry_membership',
                         'loaded_location_target_contract', 'not_current_NodeRED_inputs_or_provider_health'],
            'service_calls_executed': False, 'provider_properties_accessed': False,
            'credentials_or_location_exported': False}


def nested_codes(setup):
    if type(setup) is not types.FunctionType:
        raise ValueError('observation_layout_unknown')
    result = {}
    for value in setup.__code__.co_consts:
        if type(value) is types.CodeType and value.co_name in ('dispatch_binding', 'call_binding'):
            if value.co_name in result:
                raise ValueError('observation_layout_unknown')
            result[value.co_name] = value
    if set(result) != {'dispatch_binding', 'call_binding'}:
        raise ValueError('observation_layout_unknown')
    return result


def closure_cell(function, expected_code, name):
    if (type(function) is not types.FunctionType
            or type(expected_code) is not types.CodeType
            or function.__code__ is not expected_code
            or function.__closure__ is None
            or len(function.__closure__) != len(expected_code.co_freevars)
            or name not in expected_code.co_freevars):
        raise ValueError('observation_layout_unknown')
    # Do not materialize other cells, globals, reprs or a recursive unwrapping.
    return function.__closure__[expected_code.co_freevars.index(name)].cell_contents


def observe(registry, accounts, account_type, service_type, job_type, setup):
    """Call only on the HA loop, with exact trusted native types and loaded setup."""
    try:
        codes = nested_codes(setup)
        services = registry.async_services_for_domain('public_bindings')
        if type(services) is not dict or len(services) > 16:
            raise ValueError('observation_layout_unknown')
        facts = unknown()
        downstream = registry.has_service('icloud', 'update')
        if type(downstream) is not bool:
            raise ValueError('observation_layout_unknown')
        if 'call' not in services:
            for row in facts.values():
                row.update(handler_ready=False, binding_loaded=False,
                           downstream_registered=downstream, collection_error=None)
            return project(facts)
        service = services['call']
        if type(service) is not service_type or type(service.job) is not job_type:
            raise ValueError('observation_layout_unknown')
        dispatch = service.job.target
        event = closure_cell(dispatch, codes['dispatch_binding'], 'binding_service_ready')
        if type(event) is not asyncio.Event:
            raise ValueError('observation_layout_unknown')
        ready = asyncio.Event.is_set(event)
        if not ready:
            for row in facts.values():
                row.update(handler_ready=False, downstream_registered=downstream,
                           collection_error=None)
            return project(facts)
        handler = closure_cell(dispatch, codes['dispatch_binding'], 'binding_service_handler')
        bindings = closure_cell(handler, codes['call_binding'], 'services')
        entities = closure_cell(handler, codes['call_binding'], 'entities')
        target_ids = closure_cell(handler, codes['call_binding'], 'location_target_ids')
        if (type(bindings) is not dict or len(bindings) > 128
                or type(entities) is not dict or len(entities) > 1024
                or type(target_ids) is not set or len(target_ids) > 512
                or type(accounts) is not tuple or len(accounts) > 16
                or any(type(account) is not account_type for account in accounts)):
            raise ValueError('observation_layout_unknown')
        for role in ROLES:
            row = facts[role]
            row.update(handler_ready=True, downstream_registered=downstream,
                       collection_error=None)
            key = (role, 'refresh_location')
            row['binding_loaded'] = key in bindings
            if key not in bindings:
                continue
            binding = bindings[key]
            if type(binding) is not dict:
                row['collection_error'] = 'binding_contract_invalid'; continue
            if (type(binding.get('location_refresh_provider')) is not str
                    or type(binding.get('target_service')) is not str):
                row['collection_error'] = 'binding_contract_invalid'; continue
            row['provider_is_icloud'] = binding.get('location_refresh_provider') == 'icloud'
            row['target_is_expected_icloud_update'] = binding.get('target_service') == 'icloud.update'
            public_target = binding.get('location_refresh_public_entity_id')
            if type(public_target) is not str:
                row['location_target_contract_valid'] = False
            else:
                entity = entities.get(public_target)
                valid = (type(entity) is tuple and len(entity) == 2
                         and type(entity[0]) is str and entity[0] == role
                         and type(entity[1]) is dict
                         and type(entity[1].get('target_entity_id')) is str
                         and entity[1]['target_entity_id'] in target_ids)
                row['location_target_contract_valid'] = valid
            data = binding.get('data')
            if type(data) is not dict or type(data.get('account')) is not str or not 0 < len(data['account']) <= 320:
                row['collection_error'] = 'binding_contract_invalid'; continue
            matches = []
            for account in accounts:
                # Native IcloudAccount stores _username and api directly. Never
                # access username/devices/requires_2fa properties or copy __dict__.
                storage = object.__getattribute__(account, '__dict__')
                if type(storage) is not dict or type(storage.get('_username')) is not str or 'api' not in storage:
                    raise ValueError('observation_layout_unknown')
                if storage['_username'] == data['account']:
                    matches.append(storage['api'] is not None)
            if len(matches) > 1:
                row['collection_error'] = 'ambiguous_loaded_account'
            else:
                row['matching_loaded_account'] = bool(matches)
                row['api_present'] = matches[0] if matches else None
        return project(facts)
    except Exception:
        # Exceptions may contain private binding/account values.
        return project(unknown())


def scope_allowed(scope, request, now):
    if (type(scope) is not dict or type(request) is not dict
            or set(scope) != {'schema_version', 'enabled', 'issued_at', 'expires_at', 'operation_id', 'release_revision'}
            or type(scope['schema_version']) is not int or scope['schema_version'] != 1
            or scope['enabled'] is not True
            or any(type(scope[k]) not in (int, float) or not math.isfinite(scope[k]) for k in ('issued_at', 'expires_at'))
            or type(now) not in (int, float) or not math.isfinite(now)
            or not scope['issued_at'] <= now < scope['expires_at']
            or not 0 < scope['expires_at'] - scope['issued_at'] <= 86400):
        return False
    return (type(scope['operation_id']) is str and re.fullmatch('[a-f0-9]{32}', scope['operation_id']) is not None
            and type(scope['release_revision']) is str and re.fullmatch('[a-f0-9]{64}', scope['release_revision']) is not None
            and scope['operation_id'] == request.get('operation_id')
            and scope['release_revision'] == request.get('release_revision'))


def read_scope(config_dir):
    """Only the fixed root-owned scope; no caller path is exposed by the MCP."""
    try:
        folder = Path(config_dir)
        if os.path.lexists(folder / '.mcp-icloud-contract-revoked'):
            return None
        fd = os.open(folder / '.mcp-icloud-contract-scope.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
                    or stat.S_IMODE(info.st_mode) != 0o644 or info.st_nlink != 1 or info.st_size > 1024):
                return None
            raw = os.read(fd, 1025)
        finally:
            os.close(fd)
        return json.loads(raw) if len(raw) <= 1024 else None
    except Exception:
        return None


def attempt_rows(container, now):
    rows = []
    data = container.get('icloud_refresh_diagnostics') if type(container) is dict else None
    for role in ROLES:
        row = {'role': role, 'state': 'not_observed', 'collection_error': None,
               'observed_at': None, 'age_seconds': None, 'stage': None,
               'outcome': None, 'exception_class': None, 'historical_attempt_only': True}
        value = data.get(role) if type(data) is dict else None
        if value is not None:
            try:
                if (type(value) is not dict or set(value) != {'stage', 'outcome', 'observed_at', 'exception_class'}
                        or type(value['stage']) is not str or value['stage'] not in ('provider_refresh', 'downstream_call')
                        or type(value['outcome']) is not str or value['outcome'] not in ('started', 'completed', 'error')
                        or type(value['observed_at']) is not str or len(value['observed_at']) > 40
                        or (value['exception_class'] is not None and (type(value['exception_class']) is not str or value['exception_class'] not in EXCEPTIONS))
                        or (value['outcome'] == 'error') != (value['exception_class'] is not None)):
                    raise ValueError('invalid')
                date = datetime.datetime.fromisoformat(value['observed_at'].replace('Z', '+00:00'))
                age = now - date.timestamp()
                if date.tzinfo is None or not math.isfinite(age) or age < 0:
                    raise ValueError('invalid')
                row.update(state='observed', observed_at=value['observed_at'], age_seconds=round(age, 3),
                           stage=value['stage'], outcome=value['outcome'], exception_class=value['exception_class'])
            except Exception:
                row.update(state='unknown', collection_error='attempt_observation_invalid')
        rows.append(row)
    return rows


def snapshot(bindings, container, public_setup_sha256, now, observed_at=None):
    """Reconstruct only known fields, including bounded latest natural attempts."""
    try:
        if observed_at is None:
            observed_at = datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat()
        else:
            if type(observed_at) is not str or len(observed_at) > 40:
                raise ValueError('invalid')
            date = datetime.datetime.fromisoformat(observed_at.replace('Z', '+00:00'))
            elapsed = now - date.timestamp()
            if date.tzinfo is None or not math.isfinite(elapsed) or not 0 <= elapsed <= 60:
                raise ValueError('invalid')
        if (type(bindings) is not dict or set(bindings) != set(project(unknown()))
                or type(bindings.get('roles')) is not list or len(bindings['roles']) != 2):
            raise ValueError('invalid')
        facts = {}
        for role, row in zip(ROLES, bindings['roles']):
            if (type(row) is not dict or set(row) != {'role', 'action', 'state', *FIELDS, 'collection_error'}
                    or row['role'] != role or row['action'] != 'refresh_location'):
                raise ValueError('invalid')
            facts[role] = {k: row[k] for k in (*FIELDS, 'collection_error')}
        cleaned = project(facts)
        if cleaned != bindings:
            raise ValueError('invalid')
        if public_setup_sha256 is not None and (type(public_setup_sha256) is not str or re.fullmatch('[a-f0-9]{64}', public_setup_sha256) is None):
            raise ValueError('invalid')
        return {'schema_version': 1, 'source': 'HA_fixed_loaded_contract_and_attempt',
                'observed_at': observed_at,
                'public_setup_sha256': public_setup_sha256, 'bindings': cleaned,
                'latest_attempts': attempt_rows(container, now),
                'functional_recovery_proven': False, 'diagnostic_calls_executed': False}
    except Exception:
        return {'schema_version': 1, 'source': 'HA_fixed_loaded_contract_and_attempt',
                'observed_at': datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat(),
                'public_setup_sha256': None, 'bindings': project(unknown()),
                'latest_attempts': attempt_rows(None, now),
                'functional_recovery_proven': False, 'diagnostic_calls_executed': False}


def validate_snapshot(value, now):
    """Strict independent serialization boundary; invalid input returns no data."""
    try:
        if (type(value) is not dict
                or set(value) != {'schema_version', 'source', 'observed_at', 'public_setup_sha256', 'bindings', 'latest_attempts', 'functional_recovery_proven', 'diagnostic_calls_executed'}
                or type(value['schema_version']) is not int or value['schema_version'] != 1
                or value['source'] != 'HA_fixed_loaded_contract_and_attempt'
                or value['functional_recovery_proven'] is not False or value['diagnostic_calls_executed'] is not False
                or type(value['latest_attempts']) is not list or len(value['latest_attempts']) != 2):
            return None
        if type(value['observed_at']) is not str or len(value['observed_at']) > 40:
            return None
        date = datetime.datetime.fromisoformat(value['observed_at'].replace('Z', '+00:00'))
        age = now - date.timestamp()
        if date.tzinfo is None or not math.isfinite(age) or not 0 <= age <= 60:
            return None
        data = {}
        baseline = attempt_rows(None, now)
        for role, row, empty in zip(ROLES, value['latest_attempts'], baseline):
            if (type(row) is not dict or set(row) != set(empty)
                    or row['role'] != role or row['historical_attempt_only'] is not True):
                return None
            if row['state'] == 'observed':
                if (row['collection_error'] is not None or type(row['age_seconds']) not in (int, float)
                        or not math.isfinite(row['age_seconds']) or row['age_seconds'] < 0):
                    return None
                data[role] = {k: row[k] for k in ('stage', 'outcome', 'observed_at', 'exception_class')}
            elif row['state'] == 'not_observed':
                if row != empty: return None
            elif row['state'] == 'unknown':
                empty.update(state='unknown', collection_error='attempt_observation_invalid')
                if row != empty: return None
                data[role] = {}  # reconstruct the explicit invalid-observation state
            else:
                return None
        rebuilt = snapshot(value['bindings'], {'icloud_refresh_diagnostics': data}, value['public_setup_sha256'], now, observed_at=value['observed_at'])
        if (rebuilt['bindings'] != value['bindings']
                or rebuilt['public_setup_sha256'] != value['public_setup_sha256']
                or any(a['state'] != b['state'] for a,b in zip(rebuilt['latest_attempts'], value['latest_attempts']))):
            return None
        return rebuilt
    except Exception:
        return None
