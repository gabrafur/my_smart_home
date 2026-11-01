"""Uninstalled Root trampoline. Other frames are not consumed or reinterpreted."""
import json
import os
from pathlib import Path
import socket
import struct
import time

SAFE_REASONS = frozenset(('binding_catalogue_revoked',
    'identity_changed_specific_owner_review_required', 'reader_unit_hash_changed',
    'reader_dependency_hash_changed', 'binding_source_identity_changed',
    'uncertain_binding_operation_requires_reconciliation', 'binding_daily_budget_exhausted',
    'binding_minimum_spacing', 'host_headroom_unconfirmed', 'reader_active_no_effect_performed',
    'binding_plan_expired', 'binding_compare_conflict', 'binding_operation_not_found',
    'foreign_binding_preserved_no_replay', 'fixed_Docker_metadata_deadline',
    'maintenance_lock_identity_changed', 'foreign_receipt_change_preserved',
    'clock_reversal_requires_reconciliation', 'binding_history_capacity'))
SAFE_REASONS |= frozenset(('restore_plan_expired','restore_binding_conflict','restore_preview_capacity',
    'instance_changed_since_original_effect','instance_changed_since_preview',
    'instance_changed_uncertain_operation_requires_reconciliation',
    'reviewed_logical_NodeRED_service_not_verified'))


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate_request_key')
        result[key] = value
    return result


def classify(raw):
    query = json.loads(raw, object_pairs_hook=unique)
    if type(query) is not dict:
        raise ValueError('binding_frame_invalid')
    action = query.get('action')
    binding = query.get('tool') in ('binding_metadata_observe', 'binding_native_preflight_observe') or (
        type(action) is str and action.startswith('nodered_'))
    return query, binding


def main(runtime=None):
    if os.geteuid() != 0:
        raise ValueError('root_socket_activation_required')
    if Path(__file__) != Path('/usr/local/lib/raspberry-nodered-binding/server.py'):
        raise ValueError('sealed_native_binding_entrypoint_required')
    if runtime is None:
        raise ValueError('sealed_binding_bootstrap_required')
    with socket.socket(fileno=0) as peer:
        peer.settimeout(3)
        _, uid, _ = struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != 1001:
            raise ValueError('unexpected_binding_peer')
        deadline = time.monotonic() + 2
        while True:
            raw = peer.recv(4097, socket.MSG_PEEK)
            if not raw or len(raw) > 4096:
                raise ValueError('binding_frame_size_limit')
            if b'\n' in raw:
                line, rest = raw.split(b'\n', 1)
                if rest:
                    raise ValueError('multiple_binding_frames_refused')
                break
            if time.monotonic() >= deadline:
                raise ValueError('incomplete_binding_frame')
            time.sleep(.01)
        query, binding = classify(line)
        if not binding:
            policy = runtime.load_policy()
            runtime.previous_identity(policy, runtime.LEGACY_SERVER)
            peer.detach()
            os.execv('/usr/bin/python3', ['/usr/bin/python3', '-I', '-S', '-B', runtime.LEGACY_SERVER])
        if peer.recv(len(raw)) != raw:
            raise ValueError('binding_frame_changed')
        tool = query.pop('tool', None)
        try:
            result = runtime.dispatch(tool, query)
        except Exception as exc:
            reason = str(exc) if isinstance(exc, ValueError) and str(exc) in SAFE_REASONS else \
                'binding_operation_unconfirmed_inspect_existing_receipt'
            result = {'state': 'unavailable', 'source': 'fixed_NodeRED_binding_executor',
                'observed_at': None, 'age_seconds': None,
                'collection_error': reason,
                'automatic_retry': False,
                'coverage': ['no_raw_errors_private_paths_or_credentials', 'no_replay_after_uncertain_effect']}
        encoded = (json.dumps(result, allow_nan=False) + '\n').encode()
        if len(encoded) > 32768:
            raise ValueError('binding_response_size_limit')
        peer.sendall(encoded)


if __name__ == '__main__':
    try:
        main(globals().get('_BOOT_RUNTIME'))
    except Exception:
        os.write(1, b'{"state":"unavailable","collection_error":"binding_transport_unconfirmed","automatic_retry":false}\n')
