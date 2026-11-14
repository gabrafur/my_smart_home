"""Bounded daily rollback selection, with no I/O or execution authority."""
import hashlib
import json
import math
import re

IMAGE = re.compile(r'^sha256:[a-f0-9]{64}$')


def select_images(images, protected, now, minimum_age_seconds=86400, maximum_images=2):
    if type(images) is not list or len(images) > 2048 or type(protected) is not set:
        raise ValueError('bounded_inventory_required')
    if maximum_images not in (1, 2):
        raise ValueError('daily_image_limit_required')
    seen = set()
    candidates = []
    for row in images:
        identity = row.get('image_id') if type(row) is dict else None
        if not isinstance(identity, str) or not IMAGE.fullmatch(identity) or identity in seen:
            raise ValueError('image_identity_invalid')
        seen.add(identity)
        tags = row.get('tags')
        if 'tags' not in row or tags not in (None, []) or identity in protected or row.get('rollback_in_use') is not False:
            continue
        created = row.get('created_at')
        if type(created) not in (int, float) or not math.isfinite(created) or created < 0 or created > now - minimum_age_seconds:
            continue
        candidates.append(row)
    return sorted(candidates, key=lambda row: (row['created_at'], row['image_id']))[:maximum_images]


def operation_id(image_id):
    if not IMAGE.fullmatch(image_id):
        raise ValueError('image_identity_invalid')
    return hashlib.sha256(('rollback-cloud-v1:' + image_id).encode()).hexdigest()


def verify_proofs(image_id, archive, cloud, format_proof):
    bare = image_id.removeprefix('sha256:')
    if archive.get('image_id') != bare or cloud.get('image_id') != bare or format_proof.get('image_id') != bare:
        raise ValueError('proof_image_mismatch')
    if archive.get('state') not in ('pc_archive_hash_verified', 'local_archive_hash_verified') or cloud.get('state') != 'cloud_roundtrip_sha256_verified':
        raise ValueError('archive_or_cloud_unverified')
    if format_proof.get('state') != 'docker_archive_manifest_and_blobs_verified':
        raise ValueError('archive_format_unverified')
    digest = archive.get('sha256')
    if not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest):
        raise ValueError('archive_digest_invalid')
    if type(archive.get('bytes')) is not int or archive['bytes'] <= 0:
        raise ValueError('archive_size_invalid')
    if cloud.get('sha256') != digest or cloud.get('bytes') != archive['bytes']:
        raise ValueError('cloud_bytes_mismatch')
    return hashlib.sha256(json.dumps({'archive': archive, 'cloud': cloud, 'format': format_proof},
                                     sort_keys=True, separators=(',', ':')).encode()).hexdigest()
