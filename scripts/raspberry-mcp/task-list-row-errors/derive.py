"""Pure derivation for the task-list row error projection fix.

A single registered thread whose daemon metadata is unavailable used to turn
the whole listing into ``partial_collection_failure`` with an empty
``collection_errors`` list. Clients then treated the registry as incomplete
and refused to look for existing work. The identity registry is complete in
that case; only one row lacks daemon state.

After the patch the top-level ``collection_error`` reflects collector-level
failures only, and row-level gaps are reported in ``row_collection_errors``
with a count, reasons and bounded thread ids. Each row keeps its own
``collection_error``; unknown stays unknown.

This module performs no file, peer, permission or proof operation. The caller
owns custody, compare-and-swap baselines, locks and installation.
"""
import copy
import hashlib
import json
import re

OLD = (b"'observed_at':iso(now),'collection_error':'partial_collection_failure' if errors or "
       b"any(r['collection_error'] for r in ordered) else None,\n"
       b"      'collection_errors':sorted(set(errors)),'coverage_partial':True,")
NEW = (b"'observed_at':iso(now),'collection_error':'partial_collection_failure' if errors else None,\n"
       b"      'collection_errors':sorted(set(errors)),\n"
       b"      'row_collection_errors':{'count':sum(1 for r in ordered if r['collection_error']),\n"
       b"        'reasons':{reason:sum(1 for r in ordered if r['collection_error']==reason)\n"
       b"          for reason in sorted({r['collection_error'] for r in ordered if r['collection_error']})},\n"
       b"        'thread_ids':[r['thread_id'] for r in ordered if r['collection_error']][:8],\n"
       b"        'registered_identities_listed':not truncated,\n"
       b"        'semantics':'row_daemon_metadata_unavailable_identity_and_adapter_records_still_listed'},\n"
       b"      'coverage_partial':True,")
SHA = re.compile(r'[a-f0-9]{64}\Z')


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def sha(body):
    return hashlib.sha256(body).hexdigest()


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


def decode(body):
    need(type(body) is bytes and 0 < len(body) <= 1048576, 'bounded_bytes_required')

    def unique(pairs):
        result = {}
        for key, value in pairs:
            need(key not in result, 'duplicate_json_key')
            result[key] = value
        return result

    value = json.loads(body, object_pairs_hook=unique)
    need(type(value) is dict, 'object_required')
    return value


def patch_task_list(source):
    """Return the patched module bytes; refuses anything but one exact site."""
    need(type(source) is bytes and source.count(OLD) == 1 and source.count(b'row_collection_errors') == 0,
         'task_list_patch_site_changed')
    patched = source.replace(OLD, NEW, 1)
    compile(patched, 'task_list.py', 'exec')
    return patched


def derive(task_list, policy, enrollment, expected):
    """Derive (task_list, policy, enrollment) after-bytes from sealed baselines.

    ``expected`` maps 'task_list', 'policy' and 'enrollment' to the caller's
    compare-and-swap SHA-256 values. Scope, quotas, approval, identity and
    every other pin must be byte-for-byte preserved.
    """
    for name, body in (('task_list', task_list), ('policy', policy), ('enrollment', enrollment)):
        need(type(expected.get(name)) is str and SHA.fullmatch(expected[name]) and
             type(body) is bytes and sha(body) == expected[name], 'before_cas_mismatch')
    p, e = decode(policy), decode(enrollment)
    need(p.get('schema') == 'raspberry-task-policy-v2' and p.get('enabled') is True and
         p.get('profile') == 'restricted' and p.get('admin_delegation') == {'enabled': False},
         'policy_scope_changed')
    sources = p.get('source_hashes')
    need(type(sources) is dict and sources.get('task_list.py') == expected['task_list'], 'policy_source_pin_changed')
    need(e.get('schema') == 'raspberry-task-peer-attestor-v2' and e.get('enabled') is True and
         e.get('policy_sha256') == expected['policy'] and
         e.get('owner_confirmation_sha256') == p.get('owner_approval_sha256'), 'enrollment_binding_changed')
    task_list_after = patch_task_list(task_list)
    policy_after = copy.deepcopy(p)
    policy_after['source_hashes']['task_list.py'] = sha(task_list_after)
    policy_bytes = canonical(policy_after)
    enrollment_after = copy.deepcopy(e)
    enrollment_after['policy_sha256'] = sha(policy_bytes)
    # Only the three intended values may differ.
    restored = copy.deepcopy(policy_after)
    restored['source_hashes']['task_list.py'] = expected['task_list']
    need(restored == p, 'policy_delta_not_minimal')
    need({k: v for k, v in enrollment_after.items() if k != 'policy_sha256'} ==
         {k: v for k, v in e.items() if k != 'policy_sha256'}, 'enrollment_delta_not_minimal')
    return task_list_after, policy_bytes, canonical(enrollment_after)
