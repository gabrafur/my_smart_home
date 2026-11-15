"""Pure derivation that re-pins one shared lock identity in a sealed policy.

Several sealed policies pin the identity (device, inode, owner, group, mode)
of the shared public-validation lock. That lock used to be created on a tmpfs,
so every boot gave it a new identity and each policy failed closed with a lock
identity error until someone re-sealed it. The lock is now a persistent file
bound over the same path at boot; this derivation moves the pin to that stable
identity once.

Only the five integers of that single lock entry and the policy hash literal
in the unit change. This module performs no file, mount or service operation.
"""
import hashlib
import json

LOCK = '/tmp/my-smart-home-public-validation.lock'


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def sha(body):
    return hashlib.sha256(body).hexdigest()


def entry(identity):
    need(type(identity) is list and len(identity) == 5 and all(type(n) is int and n >= 0 for n in identity),
         'lock_identity_shape')
    return ('"%s":[%s]' % (LOCK, ','.join(str(n) for n in identity))).encode()


def patch_policy(before, old_identity, new_identity):
    need(type(before) is bytes and 0 < len(before) <= 262144, 'policy_bytes_required')
    policy = json.loads(before)
    need(policy['shared_locks'].get(LOCK) == old_identity, 'policy_pin_does_not_match_baseline')
    need(old_identity != new_identity, 'lock_identity_already_current')
    need(new_identity[2:] == old_identity[2:], 'lock_owner_or_mode_must_not_change')
    old, new = entry(old_identity), entry(new_identity)
    need(before.count(old) == 1, 'policy_pin_not_unique')
    after = before.replace(old, new)
    policy['shared_locks'][LOCK] = new_identity
    need(json.loads(after) == policy, 'policy_changed_beyond_pin')
    return after


def patch_unit(before, policy_before, policy_after):
    need(type(before) is bytes and 0 < len(before) <= 65536, 'unit_bytes_required')
    old, new = sha(policy_before).encode(), sha(policy_after).encode()
    need(before.count(old) == 1 and before.count(new) == 0, 'unit_policy_literal_not_unique')
    return before.replace(old, new)


def derive(policy_before, unit_before, old_identity, new_identity):
    policy_after = patch_policy(policy_before, old_identity, new_identity)
    return policy_after, patch_unit(unit_before, policy_before, policy_after)
