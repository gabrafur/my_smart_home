"""Pure derivation that installs a new Node-RED administration engine across its pin chain.

An apply whose outcome was lost stays ``uncertain`` and, by design, blocks every
later preflight with ``prior_uncertain_deploy_requires_reconciliation``. The
engine had no way to close that state. The candidate engine admits a sealed Root
reconciliation record bound to the exact plan, intent and receipt that keeps the
receipt ``uncertain`` (never promoted to ``applied``), and records the fixed stage
at which certainty was lost. Only the hashes that depend on the engine move:

  engine source -> administration policy (sources/engine.py) -> administration unit

Every other policy field and unit byte is unchanged. The caller owns custody,
compare-and-swap baselines and installation.
"""
import hashlib
import json

NAMES = ('engine', 'admin_policy', 'admin_unit')


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def sha(body):
    return hashlib.sha256(body).hexdigest()


def swap(body, old, new, reason):
    need(body.count(old) == 1 and body.count(new) == 0, reason)
    return body.replace(old, new)


def derive(before, engine_after):
    need(type(before) is dict and set(before) == set(NAMES)
         and all(type(v) is bytes and 0 < len(v) <= 1048576 for v in before.values()), 'three_fixed_inputs_required')
    need(type(engine_after) is bytes and 0 < len(engine_after) <= 1048576
         and engine_after != before['engine'], 'new_engine_required')
    after = {'engine': engine_after}
    old, new = sha(before['engine']), sha(engine_after)
    policy = json.loads(before['admin_policy'])
    need(policy['sources']['engine.py'] == old, 'admin_policy_baseline')
    after['admin_policy'] = swap(before['admin_policy'], old.encode(), new.encode(), 'admin_policy_engine_anchor')
    policy['sources']['engine.py'] = new
    need(json.loads(after['admin_policy']) == policy, 'admin_policy_changed_beyond_pin')
    after['admin_unit'] = swap(before['admin_unit'], sha(before['admin_policy']).encode(),
                               sha(after['admin_policy']).encode(), 'admin_unit_policy_anchor')
    return after
