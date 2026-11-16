"""Pure derivation that re-binds the session-cleanup source pins after a Node-RED container recreation.

The native recovery of an unrevoked own admin session reads three public Node-RED
auth/storage sources inside the container and compares every ancestor directory
identity (device, inode, uid, gid, mode) with ``session_cleanup_recovery.
runtime_source_parent_pins`` in the administration policy. Recreating the container
from the same image changes the overlay device and the root inode, so every
recovery fails with ``runtime_ancestor_identity_changed`` and the admin MCP stays
blocked by the unconfirmed session. This derivation replaces only those pins with
live identities for the same paths, keeps uid/gid/mode and the source hashes, and
moves the policy hash in the administration unit:

  live container identities -> administration policy -> administration unit

The caller reads the live identities, verifies the source hashes and owns custody.
"""
import hashlib
import json

NAMES = ('admin_policy', 'admin_unit')


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def sha(body):
    return hashlib.sha256(body).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode() + b'\n'


def derive(before, live):
    need(type(before) is dict and set(before) == set(NAMES)
         and all(type(v) is bytes and 0 < len(v) <= 1048576 for v in before.values()), 'two_fixed_inputs_required')
    policy = json.loads(before['admin_policy'])
    need(canonical(policy) == before['admin_policy'], 'policy_not_canonical')
    pins = policy['session_cleanup_recovery']['runtime_source_parent_pins']
    need(type(live) is dict and set(live) == set(pins)
         and all(type(live[k]) is dict and set(live[k]) == set(pins[k]) for k in pins), 'same_paths_and_ancestors_required')
    for path, ancestors in pins.items():
        for name, old in ancestors.items():
            new = live[path][name]
            need(type(new) is list and len(new) == 5 and all(type(x) is int and x >= 0 for x in new)
                 and new[2:] == old[2:], 'only_device_and_inode_may_change')
    need(live != pins, 'pins_already_current')
    after_policy = json.loads(before['admin_policy'])
    after_policy['session_cleanup_recovery']['runtime_source_parent_pins'] = live
    body = canonical(after_policy)
    check = json.loads(body)
    check['session_cleanup_recovery']['runtime_source_parent_pins'] = pins
    need(check == policy, 'policy_changed_beyond_cleanup_pins')
    old, new = sha(before['admin_policy']).encode(), sha(body).encode()
    need(before['admin_unit'].count(old) == 1 and before['admin_unit'].count(new) == 0, 'admin_unit_policy_anchor')
    return {'admin_policy': body, 'admin_unit': before['admin_unit'].replace(old, new)}
