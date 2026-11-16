"""Pure derivation that replaces the pinned repair-control events test.

The installed ``test_events.mjs`` still expected an unloaded legacy repair
thread to resume without a profile, while the reviewed runtime refuses that
with ``legacy_resume_profile_unenrolled``. The test is pinned by hash in the
repair-control policy, whose hash is pinned in the component-repair policy,
whose hash is pinned in three component unit templates:

  test -> repair-control policy -> component-repair policy -> guard/job/validate units

Every pin moves by an exact byte swap with an expected count of one; both JSON
policies must stay identical outside the moved pins. The caller owns custody,
compare-and-swap baselines and installation. No service restarts.
"""
import hashlib
import json

NAMES = ('test', 'repair_policy', 'component_policy', 'guard_unit', 'job_unit', 'validate_unit')
UNITS = NAMES[3:]


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def sha(body):
    return hashlib.sha256(body).hexdigest()


def swap(body, old, new, reason):
    need(body.count(old.encode()) == 1 and body.count(new.encode()) == 0, reason)
    return body.replace(old.encode(), new.encode())


def derive(before, test):
    need(type(before) is dict and set(before) == set(NAMES)
         and all(type(v) is bytes and 0 < len(v) <= 1048576 for v in before.values()), 'six_fixed_inputs_required')
    need(type(test) is bytes and 0 < len(test) <= 262144 and test != before['test'], 'new_test_required')
    after = {'test': test}
    for name, dep in (('repair_policy', 'test'), ('component_policy', 'repair_policy')):
        old, new = sha(before[dep]), sha(after[dep])
        body = swap(before[name], old, new, name + '_pin_anchor')
        need(json.loads(body.replace(new.encode(), old.encode())) == json.loads(before[name]),
             name + '_changed_beyond_pin')
        after[name] = body
    for unit in UNITS:
        after[unit] = swap(before[unit], sha(before['component_policy']), sha(after['component_policy']),
                           unit + '_policy_anchor')
    return after
