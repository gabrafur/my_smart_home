"""Pure derivation that re-binds the sealed Node-RED administration chain to a recreated container.

The closed metadata reader and the administration guard pin the exact
container identity and the Compose files label of the Node-RED container.
Recreating the container (new image, new network settings) changes the
identity, and every administration read then fails closed. This derivation
moves those two values and refreshes only the hashes that depend on them:

  reader source -> reader policy -> reader unit
  guard source  -> administration policy (guard, reader, reader policy and
                   reader unit hashes) -> administration unit

Image pin, grants, credentials, sources and every other field are unchanged.
The caller observes the live container, owns custody, compare-and-swap
baselines, the reader restart and installation.
"""
import hashlib
import json
import re

NAMES = ('reader', 'reader_policy', 'reader_unit', 'guard', 'admin_policy', 'admin_unit')
ID = re.compile(r'[a-f0-9]{64}\Z')
LABEL = re.compile(r'/[A-Za-z0-9._/-]+(?:,/[A-Za-z0-9._/-]+)*\Z')
KEY = b'com.docker.compose.project.config_files'


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def sha(body):
    return hashlib.sha256(body).hexdigest()


def swap(body, old, new, count, reason):
    need(body.count(old) == count and (old == new or body.count(new) == 0), reason)
    return body.replace(old, new)


def swap_label(body, old, new, count):
    """Replace the label value only where it directly follows the label key."""
    pattern = re.compile(re.escape(KEY) + rb"(\\?'\s*:\s*\\?')" + re.escape(old) + rb"(\\?')")
    after, done = pattern.subn(lambda m: KEY + m.group(1) + new + m.group(2), body)
    need(done == count, 'label_anchor_count')
    return after


def derive(before, old_id, new_id, old_label, new_label, old_docker=None, new_docker=None):
    """Re-bind to a recreated container and/or to an updated Docker CLI binary.

    old_docker/new_docker (both or neither) move the pinned SHA-256 of /usr/bin/docker that the
    reader and the guard verify before every inspection; the caller proves the new binary
    (package integrity) before passing it. With only the Docker pair, identity and label stay.
    """
    need(type(before) is dict and set(before) == set(NAMES)
         and all(type(v) is bytes and 0 < len(v) <= 1048576 for v in before.values()), 'six_fixed_inputs_required')
    need((old_docker is None) == (new_docker is None), 'docker_pair_required')
    if old_docker is not None:
        need(all(type(v) is str and ID.match(v) for v in (old_docker, new_docker)) and old_docker != new_docker,
             'docker_digest_shape')
    need(all(type(v) is str and ID.match(v) for v in (old_id, new_id)) and
         (old_id != new_id or old_docker is not None), 'container_identity_shape')
    need(all(type(v) is str and LABEL.match(v) for v in (old_label, new_label)), 'label_shape')
    oid, nid, olab, nlab = (v.encode() for v in (old_id, new_id, old_label, new_label))
    h = {name: sha(body).encode() for name, body in before.items()}
    after = {}

    after['reader'] = swap_label(swap(before['reader'], oid, nid, 1, 'reader_identity_anchor'), olab, nlab, 1)
    if old_docker is not None:
        after['reader'] = swap(after['reader'], old_docker.encode(), new_docker.encode(), 1, 'reader_docker_anchor')
    policy = json.loads(before['reader_policy'])
    need(policy.get('container_id') == old_id and policy.get('source_sha256') == h['reader'].decode()
         and policy.get('enabled') is True, 'reader_policy_baseline')
    body = swap(before['reader_policy'], oid, nid, 1, 'reader_policy_identity_anchor')
    after['reader_policy'] = swap(body, h['reader'], sha(after['reader']).encode(), 1, 'reader_policy_source_anchor')
    policy.update(container_id=new_id, source_sha256=sha(after['reader']))
    need(json.loads(after['reader_policy']) == policy, 'reader_policy_changed_beyond_pins')
    after['reader_unit'] = swap(before['reader_unit'], h['reader_policy'], sha(after['reader_policy']).encode(), 1,
                                'reader_unit_policy_anchor')

    after['guard'] = swap_label(swap(before['guard'], oid, nid, 2, 'guard_identity_anchor'), olab, nlab, 2)
    if old_docker is not None:
        after['guard'] = swap(after['guard'], old_docker.encode(), new_docker.encode(), 1, 'guard_docker_anchor')
    admin = json.loads(before['admin_policy'])
    producer = admin['native_guard_producer']['continuity_metadata_reader']
    need(admin['sources']['native_guard.py'] == h['guard'].decode()
         and producer['reader_source_sha256'] == h['reader'].decode()
         and producer['reader_policy_sha256'] == h['reader_policy'].decode()
         and producer['service_unit_sha256'] == h['reader_unit'].decode(), 'admin_policy_baseline')
    need(admin['native_guard_producer'].get('source_sha256') == h['guard'].decode(), 'admin_policy_baseline')
    body = before['admin_policy']
    # The guard hash is pinned twice: as a loaded source and as the producer.
    for name, count in (('guard', 2), ('reader', 1), ('reader_policy', 1), ('reader_unit', 1)):
        body = swap(body, h[name], sha(after[name]).encode(), count, 'admin_policy_' + name + '_anchor')
    after['admin_policy'] = body
    admin['sources']['native_guard.py'] = sha(after['guard'])
    admin['native_guard_producer']['source_sha256'] = sha(after['guard'])
    producer.update(reader_source_sha256=sha(after['reader']), reader_policy_sha256=sha(after['reader_policy']),
                    service_unit_sha256=sha(after['reader_unit']))
    need(json.loads(after['admin_policy']) == admin, 'admin_policy_changed_beyond_pins')
    after['admin_unit'] = swap(before['admin_unit'], h['admin_policy'], sha(after['admin_policy']).encode(), 1,
                               'admin_unit_policy_anchor')
    return after
