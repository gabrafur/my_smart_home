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


IMAGE_NAMES = ('reader', 'reader_policy', 'reader_unit', 'guard', 'admin_policy', 'admin_unit',
               'activation', 'review', 'evidence')
VERSION = re.compile(r'[0-9]+\.[0-9]+\.[0-9]+\Z')


def derive_image(before, old_id, new_id, old_image, new_image, old_version, new_version, label):
    """Re-bind the chain to a recreated container running a NEW image of the same Node-RED runtime package.

    Beyond identity (see derive), this moves the image pin (reader, its policy, the activation) and the core
    version string (guard, activation, review, evidence) and refreshes the hashes that depend on them:
      evidence -> review -> administration policy; activation -> administration policy;
      reader -> reader policy -> reader unit; guard -> administration policy -> administration unit.
    The caller must prove that the files the evidence is about (the whole @node-red/runtime package) are
    byte-identical in the new image; this function never judges that, it only moves pins.
    """
    need(type(before) is dict and set(before) == set(IMAGE_NAMES)
         and all(type(v) is bytes and 0 < len(v) <= 1048576 for v in before.values()), 'nine_fixed_inputs_required')
    need(all(type(v) is str and ID.match(v) for v in (old_id, new_id, old_image, new_image)) and old_id != new_id
         and old_image != new_image, 'image_identity_shape')
    need(all(type(v) is str and VERSION.match(v) for v in (old_version, new_version)) and old_version != new_version,
         'core_version_shape')
    need(type(label) is str and LABEL.match(label), 'label_shape')
    oid, nid, oimg, nimg, lab = (v.encode() for v in (old_id, new_id, old_image, new_image, label))
    overs, nvers = old_version.encode(), new_version.encode()
    h = {name: sha(body).encode() for name, body in before.items()}
    after = {}

    def versioned(body, quoted):
        old, new = (b'"core_version": "%s"' % overs, b'"core_version": "%s"' % nvers) if quoted == 'spaced' else \
            (b'"core_version":"%s"' % overs, b'"core_version":"%s"' % nvers)
        return swap(body, old, new, 1, 'core_version_anchor')

    after['evidence'] = versioned(before['evidence'], 'compact')
    review = json.loads(before['review'])
    need(review.get('core_version') == old_version and review.get('isolated_evidence_sha256') == h['evidence'].decode(),
         'review_baseline')
    body = versioned(before['review'], 'spaced')
    after['review'] = swap(body, h['evidence'], sha(after['evidence']).encode(), 1, 'review_evidence_anchor')
    review.update(core_version=new_version, isolated_evidence_sha256=sha(after['evidence']))
    need(json.loads(after['review']) == review, 'review_changed_beyond_pins')
    activation = json.loads(before['activation'])
    need(activation.get('core_version') == old_version and activation.get('image_digest') == 'sha256:' + old_image,
         'activation_baseline')
    body = versioned(before['activation'], 'spaced')
    after['activation'] = swap(body, b'sha256:' + oimg, b'sha256:' + nimg, 1, 'activation_image_anchor')
    activation.update(core_version=new_version, image_digest='sha256:' + new_image)
    need(json.loads(after['activation']) == activation, 'activation_changed_beyond_pins')

    after['reader'] = swap(swap(before['reader'], oid, nid, 1, 'reader_identity_anchor'), b"IMAGE='sha256:" + oimg,
                           b"IMAGE='sha256:" + nimg, 1, 'reader_image_anchor')
    policy = json.loads(before['reader_policy'])
    need(policy.get('container_id') == old_id and policy.get('image') == 'sha256:' + old_image
         and policy.get('source_sha256') == h['reader'].decode() and policy.get('enabled') is True, 'reader_policy_baseline')
    body = swap(before['reader_policy'], oid, nid, 1, 'reader_policy_identity_anchor')
    body = swap(body, b'sha256:' + oimg, b'sha256:' + nimg, 1, 'reader_policy_image_anchor')
    after['reader_policy'] = swap(body, h['reader'], sha(after['reader']).encode(), 1, 'reader_policy_source_anchor')
    policy.update(container_id=new_id, image='sha256:' + new_image, source_sha256=sha(after['reader']))
    need(json.loads(after['reader_policy']) == policy, 'reader_policy_changed_beyond_pins')
    after['reader_unit'] = swap(before['reader_unit'], h['reader_policy'], sha(after['reader_policy']).encode(), 1,
                                'reader_unit_policy_anchor')

    guard = swap(before['guard'], oid, nid, 2, 'guard_identity_anchor')
    guard = swap(guard, b"activation['core_version'] == '%s'" % overs, b"activation['core_version'] == '%s'" % nvers, 1,
                 'guard_activation_version_anchor')
    after['guard'] = swap(guard, b"evidence.get('core_version') == '%s'" % overs,
                          b"evidence.get('core_version') == '%s'" % nvers, 1, 'guard_evidence_version_anchor')
    admin = json.loads(before['admin_policy'])
    producer = admin['native_guard_producer']['continuity_metadata_reader']
    top = admin['native_guard_producer']
    need(admin['sources']['native_guard.py'] == h['guard'].decode() and top.get('source_sha256') == h['guard'].decode()
         and producer['reader_source_sha256'] == h['reader'].decode()
         and producer['reader_policy_sha256'] == h['reader_policy'].decode()
         and producer['service_unit_sha256'] == h['reader_unit'].decode()
         and top.get('runtime_activation_sha256') == h['activation'].decode()
         and top.get('isolated_review_sha256') == h['review'].decode(), 'admin_policy_baseline')
    body = before['admin_policy']
    for name, count in (('guard', 2), ('reader', 1), ('reader_policy', 1), ('reader_unit', 1),
                        ('activation', 1), ('review', 1)):
        body = swap(body, h[name], sha(after[name]).encode(), count, 'admin_policy_' + name + '_anchor')
    after['admin_policy'] = body
    admin['sources']['native_guard.py'] = sha(after['guard'])
    top['source_sha256'] = sha(after['guard'])
    top['runtime_activation_sha256'] = sha(after['activation'])
    top['isolated_review_sha256'] = sha(after['review'])
    producer.update(reader_source_sha256=sha(after['reader']), reader_policy_sha256=sha(after['reader_policy']),
                    service_unit_sha256=sha(after['reader_unit']))
    need(json.loads(after['admin_policy']) == admin, 'admin_policy_changed_beyond_pins')
    after['admin_unit'] = swap(before['admin_unit'], h['admin_policy'], sha(after['admin_policy']).encode(), 1,
                               'admin_unit_policy_anchor')
    return after
