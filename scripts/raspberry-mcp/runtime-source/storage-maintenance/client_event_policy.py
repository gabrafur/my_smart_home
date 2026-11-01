"""Sanitized client-policy projection candidate; no IO, schedule or cleanup."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import stat

POLICY = Path('/usr/local/lib/raspberry-mcp-storage/client-event-policy.json')
REVOKED = Path('/var/lib/raspberry-mcp-storage/client-policy-revoked')

APPROVED = {
    'schema_version': 1,
    'policy_sha256': '1'*64,  # Synthetic default; runtime accepts a root-verified digest.
    'kind': 'client_response_to_natural_storage_health_events',
    'enabled': True, 'expires_at': None,
    'scopes': ['npm_logs', 'npm_temporary'],
    'maximum_items_per_batch': 32, 'maximum_bytes_per_batch': 16777216,
    'maximum_batches_per_24h': 4, 'minimum_spacing_seconds': 21600,
    'maximum_retained_quarantine_bytes': 536870912,
    'plan_validity_seconds': 900, 'interface_confirmations_required': True,
    'server_scheduling_enabled': False, 'permanent_deletion_allowed': False,
}

def project(value, *, identity_verified=False, revoked=None):
    result = {
        'source': 'fixed_owner_approved_client_event_policy',
        'observed_at': datetime.now(timezone.utc).isoformat(), 'age_seconds': 0,
        'state': 'unknown', 'collection_error': 'client_policy_unverified',
        'approval_active': False, 'execution_proven': False,
        'server_scheduling_enabled': False,
        'coverage': ['client_authorization_only_not_executor_admission_or_execution'],
    }
    if identity_verified is not True or type(revoked) is not bool:
        return result
    if revoked:
        result.update(state='revoked', collection_error=None)
        return result
    # JSON equality alone equates booleans and numbers. Compare each field's
    # type before equality so a malformed policy never grants client admission.
    if (type(value) is not dict or set(value) != set(APPROVED)
            or any(type(value[k]) is not type(v) or value[k] != v
                   for k, v in APPROVED.items() if k != 'policy_sha256')
            or type(value.get('policy_sha256')) is not str
            or re.fullmatch('[a-f0-9]{64}', value['policy_sha256']) is None):
        result['collection_error'] = 'client_policy_shape_or_scope_refused'
        return result
    # Emit fixed reviewed constants, never caller-provided text or objects.
    result.update(state='approved', collection_error=None, approval_active=True,
                  policy={**APPROVED, 'policy_sha256':value['policy_sha256'],
                          'scopes': list(APPROVED['scopes'])})
    return result

def observe():
    """Only the two fixed root-owned metadata files; never constructs an engine."""
    try:
        revoked=False
        try:
            info=REVOKED.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or stat.S_IMODE(info.st_mode)!=0o600:
                return project(None)
            revoked=True
        except FileNotFoundError:
            pass
        fd=os.open(POLICY,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or stat.S_IMODE(info.st_mode)!=0o644 or info.st_size>16384:
                return project(None)
            raw=os.read(fd,16385)
            if len(raw)>16384:return project(None)
        finally:os.close(fd)
        return project(json.loads(raw),identity_verified=True,revoked=revoked)
    except (OSError,ValueError,TypeError):
        return project(None)
