"""Pure review of fixed notice pins; no filesystem or authority effects.

The operator supplies reviewed before/after public bytes and separately read
installed bytes. Never learn a trusted pin from an unreviewed live file. This
does not install anything, renew a lease or bypass configuration verification.
"""
import copy
import hashlib
import json

ROOT = '/usr/local/lib/raspberry-ha-notices/'
FILES = ('content_sanitizer.cjs', 'diagnostic_templates.json', 'notification_state.cjs')
POLICIES = {'repair': '/usr/local/lib/raspberry-repair-control/policy.json',
            'admin': '/usr/local/lib/raspberry-admin-executor/policy.json'}


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def candidate(policy, before_public, after_public, installed, *, policy_kind='repair'):
    """Return a copy changing only the selected fixed notice hashes, or refuse."""
    need(type(policy) is dict and type(policy.get('dependencies')) is dict,
         'notice_dependency_policy_invalid')
    need(type(policy_kind) is str and policy_kind in POLICIES, 'notice_dependency_policy_scope_changed')
    for values in (before_public, after_public, installed):
        need(type(values) is dict and set(values) == set(FILES) and
             all(type(raw) is bytes and 0 < len(raw) <= 65536 for raw in values.values()),
             'notice_dependency_source_scope_changed')
    out = copy.deepcopy(policy)
    changes = []
    selected = FILES if policy_kind == 'repair' else ('notification_state.cjs',)
    for name in selected:
        path = ROOT + name
        need(policy['dependencies'].get(path) == sha(before_public[name]),
             'notice_dependency_baseline_changed')
        need(installed[name] == after_public[name], 'notice_dependency_live_not_reviewed')
        need(before_public[name] != after_public[name], 'notice_dependency_not_changed')
        out['dependencies'][path] = sha(after_public[name])
        changes.append({'file': name, 'before_sha256': sha(before_public[name]),
                        'after_sha256': sha(after_public[name])})
    # A structural equality check also covers unknown future policy fields.
    restored = copy.deepcopy(out)
    for name in selected:
        restored['dependencies'][ROOT + name] = policy['dependencies'][ROOT + name]
    need(restored == policy, 'notice_dependency_authority_changed')
    return out, changes


def unchanged_policy(policy, expected_before):
    """Exact final compare before the caller's one-shot atomic publication."""
    need(type(policy) is bytes and type(expected_before) is bytes,
         'notice_dependency_policy_invalid')
    need(policy == expected_before, 'notice_dependency_policy_changed')


def reviewed_candidates(policies, before_public, after_public, installed):
    """Plan both policies, including repair's exact dependency on admin bytes."""
    need(type(policies) is dict and set(policies) == set(POLICIES) and
         all(type(raw) is bytes and 0 < len(raw) <= 1048576 for raw in policies.values()),
         'notice_dependency_policy_scope_changed')
    bodies = {kind: json.loads(raw) for kind, raw in policies.items()}
    admin, admin_delta = candidate(bodies['admin'], before_public, after_public, installed,
                                   policy_kind='admin')
    repair, repair_delta = candidate(bodies['repair'], before_public, after_public, installed)
    encode = lambda value: (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()
    admin_raw = encode(admin)
    path = POLICIES['admin']
    need(bodies['repair']['dependencies'].get(path) == sha(policies['admin']),
         'notice_dependency_admin_baseline_changed')
    repair['dependencies'][path] = sha(admin_raw)
    repair_delta.append({'file': 'admin_policy', 'before_sha256': sha(policies['admin']),
                         'after_sha256': sha(admin_raw)})
    return {'admin': admin_raw, 'repair': encode(repair)}, {'admin': admin_delta, 'repair': repair_delta}
