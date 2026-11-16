"""Pure derivation that installs notice ingress provenance across its sealed pin chain.

The HA notice reader labelled every row ``homeassistant.persistent_notification``
with origin ``not_provided_by_HA``, including rows that entered through the
private operational spool. The candidate sources tag the ingress at the
collector boundary and carry it through state, reader, private text and model.
Six installed sources change; these hashes are pinned in four policies and the
last policy in three units:

  sources -> private-content policy (collector, text, capture, model)
          -> admin-executor policy (collector, state)
          -> repair-control policy (admin policy, reader, state)
          -> component-repair policy (admin policy, repair policy)
          -> component guard/job/validate units (component policy)

Every pin moves by an exact byte swap with an expected count of one, and each
JSON policy must stay identical outside the moved pins. The caller owns
custody, compare-and-swap baselines, the collector restart and installation.
"""
import hashlib
import json

SOURCES = ('notification_collector.cjs', 'notification_reader.py', 'notification_state.cjs',
           'notification_text.cjs', 'private_capture.cjs', 'private_notice_model.cjs')
POLICIES = ('private_policy', 'admin_policy', 'repair_policy', 'component_policy')
UNITS = ('guard_unit', 'job_unit', 'validate_unit')
NAMES = SOURCES + POLICIES + UNITS
PINS = {'private_policy': ('notification_collector.cjs', 'notification_text.cjs', 'private_capture.cjs',
                           'private_notice_model.cjs'),
        'admin_policy': ('notification_collector.cjs', 'notification_state.cjs'),
        'repair_policy': ('admin_policy', 'notification_reader.py', 'notification_state.cjs'),
        'component_policy': ('admin_policy', 'repair_policy')}


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def sha(body):
    return hashlib.sha256(body).hexdigest()


def swap_pins(body, moves, reason):
    after = body
    for old, new in moves:
        need(after.count(old.encode()) == 1 and after.count(new.encode()) == 0, reason)
        after = after.replace(old.encode(), new.encode())
    return after


def json_unchanged_outside(before, after, moves):
    restored = after
    for old, new in moves:
        restored = restored.replace(new.encode(), old.encode())
    return json.loads(restored) == json.loads(before)


def derive(before, candidates):
    need(type(before) is dict and set(before) == set(NAMES)
         and all(type(v) is bytes and 0 < len(v) <= 1048576 for v in before.values()), 'thirteen_fixed_inputs_required')
    need(type(candidates) is dict and set(candidates) == set(SOURCES)
         and all(type(v) is bytes and 0 < len(v) <= 1048576 for v in candidates.values()), 'six_candidates_required')
    need(all(candidates[n] != before[n] for n in SOURCES), 'candidate_equals_installed')
    after = {n: candidates[n] for n in SOURCES}
    for policy in POLICIES:
        moves = [(sha(before[dep]), sha(after[dep])) for dep in PINS[policy]]
        body = swap_pins(before[policy], moves, policy + '_pin_anchor')
        need(json_unchanged_outside(before[policy], body, moves), policy + '_changed_beyond_pins')
        after[policy] = body
    move = [(sha(before['component_policy']), sha(after['component_policy']))]
    for unit in UNITS:
        after[unit] = swap_pins(before[unit], move, unit + '_policy_anchor')
    return after
