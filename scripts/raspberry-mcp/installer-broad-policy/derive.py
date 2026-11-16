"""Pure derivation: let the fixed maintenance installer accept the optional broad client policy.

The client-broad worker already validates an optional ``broad_task_profile`` with an
exact contract. The installed fixed_installer.validate_client_policy_payload still
refuses that key, so a native client cutover to the broad policy would stop at its
preflight. This derivation adds the same exact contract to the installer and moves
only the hashes that pin the installer source:

  fixed_installer.py -> owner-policy installer_sources, install-enrollment sources,
  package-enrollment-approval source_hashes, catalogue-manifest row,
  bootstrap-manifest rows (+ its core digest; the bootstrap domain is inert)

Every other byte is preserved. The caller owns custody, CAS and installation.
"""
import hashlib
import json
import re

NAMES = ('fixed_installer', 'owner_policy', 'install_enrollment', 'package_enrollment_approval',
         'catalogue_manifest', 'bootstrap_manifest')
OLD = ("    need(type(value) is dict and set(value)==set(CLIENT_POLICY_EXPECTED)|{'enabled','revoked','approval_sha256'}, "
       "'client_policy_schema_refused')")
NEW = ("    need(type(value) is dict and set(value)-{'broad_task_profile'}==set(CLIENT_POLICY_EXPECTED)|{'enabled','revoked','approval_sha256'}, "
       "'client_policy_schema_refused')\n"
       "    if 'broad_task_profile' in value:\n"
       "        # Optional broad task extension: exactly the client-broad worker contract.\n"
       "        broad=value['broad_task_profile']\n"
       "        need(type(broad) is dict and set(broad)==set(CLIENT_BROAD_EXPECTED)|{'enabled','revoked'}, 'client_broad_schema_refused')\n"
       "        need(canonical({k:broad[k] for k in CLIENT_BROAD_EXPECTED})==canonical(CLIENT_BROAD_EXPECTED), 'client_broad_scope_refused')\n"
       "        need(type(broad['enabled']) is bool and type(broad['revoked']) is bool, 'client_broad_flags_refused')")
ANCHOR = 'def validate_client_policy_payload(raw, gate):'


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def sha(body):
    return hashlib.sha256(body).hexdigest()


def canonical(v):
    return json.dumps(v, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def swap(body, old, new, reason):
    need(body.count(old) == 1 and body.count(new) == 0, reason)
    return body.replace(old, new)


def broad_contract(worker):
    found = re.findall(rb'^BROAD_EXPECTED = (\{.*\})$', worker, re.M)
    need(len(found) == 1, 'worker_broad_contract')
    return found[0]


def derive(before, worker):
    need(type(before) is dict and set(before) == set(NAMES) and all(type(v) is bytes for v in before.values()), 'six_inputs')
    src = before['fixed_installer']
    need(b'broad_task_profile' not in src and b'CLIENT_BROAD_EXPECTED' not in src, 'installer_already_broad')
    contract = broad_contract(worker)
    after = {'fixed_installer': swap(swap(src, OLD.encode(), NEW.encode(), 'installer_validator_anchor'),
                                     ANCHOR.encode(), b'CLIENT_BROAD_EXPECTED=' + contract + b'\n\n' + ANCHOR.encode(),
                                     'installer_function_anchor')}
    old, new = sha(src), sha(after['fixed_installer'])
    for name in ('owner_policy', 'install_enrollment', 'package_enrollment_approval', 'catalogue_manifest'):
        after[name] = swap(before[name], old.encode(), new.encode(), name + '_installer_pin')
    boot = before['bootstrap_manifest']
    for name in ('fixed_installer', 'install_enrollment', 'package_enrollment_approval', 'catalogue_manifest'):
        o, n = sha(before[name]), sha(after[name])
        if boot.count(o.encode()) == 1:
            boot = swap(boot, o.encode(), n.encode(), 'bootstrap_row_' + name)
        else:
            need(name != 'fixed_installer', 'bootstrap_installer_row')
    manifest = json.loads(boot)
    old_digest = json.loads(before['bootstrap_manifest'])['manifest_sha256']
    new_digest = sha(canonical({'files': manifest['files'], 'expires_at': manifest['expires_at']}))
    after['bootstrap_manifest'] = swap(boot, old_digest.encode(), new_digest.encode(), 'bootstrap_digest')
    for name in NAMES[1:]:
        a, b = json.loads(after[name]), json.loads(before[name])
        need(type(a) is dict and set(a) == set(b), name + '_shape_changed')
    return after
