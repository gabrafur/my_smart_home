"""Fixed read-only Docker metadata producer; no names, caller paths or cleanup."""
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
import os
import re
import selectors
import subprocess
import time

SOURCE = 'existing_Storage_Health_Docker_report'
KINDS = {'Images': 'images', 'Containers': 'containers', 'Local Volumes': 'volumes', 'Build Cache': 'build_cache'}
MAX_BYTES = 65536
MAX_IMAGES = 256
MAX_SECONDS = 5


def size(value):
    m = re.fullmatch(r'([0-9]+(?:\.[0-9]+)?)\s*(B|kB|MB|GB|TB)', value) if isinstance(value, str) else None
    if not m:
        raise ValueError('invalid_size')
    n = int(Decimal(m[1]) * {'B': 1, 'kB': 1000, 'MB': 10**6, 'GB': 10**9, 'TB': 10**12}[m[2]])
    if not 0 <= n <= 2**63-1:
        raise ValueError('invalid_size')
    return n


def command(args, deadline):
    """Bound stdout and wall time. Only this module supplies fixed arguments."""
    with subprocess.Popen(['/usr/bin/docker', *args], stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}) as process:
        output = bytearray()
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        try:
            while True:
                left = deadline-time.monotonic()
                if left <= 0 or not selector.select(left):
                    raise ValueError('measurement_timeout')
                block = os.read(process.stdout.fileno(), min(8192, MAX_BYTES+1-len(output)))
                if not block:
                    break
                output.extend(block)
                if len(output) > MAX_BYTES:
                    raise ValueError('measurement_output_limit')
            if process.wait(timeout=max(0.01, deadline-time.monotonic())) != 0:
                raise ValueError('measurement_failed')
            return bytes(output).decode('utf-8')
        finally:
            selector.close()
            if process.poll() is None:
                process.kill()
                process.wait(timeout=1)


def aggregate(text):
    rows = [json.loads(line) for line in text.splitlines() if line]
    if len(rows) != 4 or not all(isinstance(r, dict) for r in rows) or {r.get('Type') for r in rows} != set(KINDS):
        raise ValueError('aggregate_incomplete')
    return [{'kind': KINDS[r['Type']], 'logical_bytes': size(r.get('Size')), 'cleanup_allowed': False} for r in rows]


def candidates(text):
    lines = text.splitlines()
    if len(lines) > MAX_IMAGES:
        raise ValueError('image_inventory_limit')
    rows = {}
    for line in lines:
        identity, reported = line.split('\t')
        if not re.fullmatch('sha256:[a-f0-9]{64}', identity):
            raise ValueError('image_identity_invalid')
        rows[identity] = size(reported)
    return sorted(rows, key=rows.get, reverse=True)[:5], len(rows)


def largest(text, identities):
    rows = {}
    for line in text.splitlines():
        identity, value = line.split(' ')
        if identity not in identities or identity in rows or not value.isdecimal() or not 0 <= int(value) <= 2**63-1:
            raise ValueError('image_size_invalid')
        rows[identity] = int(value)
    if set(rows) != set(identities):
        raise ValueError('image_inspection_incomplete')
    return [{'item_id': hashlib.sha256(identity.encode()).hexdigest()[:24], 'logical_bytes': value}
            for identity, value in sorted(rows.items(), key=lambda row: row[1], reverse=True)]


def collect(run=command):
    started = time.monotonic()
    deadline = started+MAX_SECONDS
    observed = datetime.now(timezone.utc).isoformat()
    result = {'source': SOURCE, 'observed_at': observed, 'age_seconds': 0,
              'state': 'unknown', 'collection_error': 'docker_measurement_unavailable',
              'data': None, 'largest_observed_images': [], 'image_inventory_count': None,
              'largest_collection_error': None,
              'coverage': ['fixed_readonly_Docker_metadata', 'logical_shared_bytes_not_additive',
                           'aggregate_sizes_follow_Docker_display_precision',
                           'largest_selection_uses_rounded_display_size_exact_inspected_bytes',
                           'maximum_256_inventory_rows_5_images_5_second_deadline_1_second_process_cleanup_65536_bytes_per_command',
                           'no_names_contents_registry_requests_or_cleanup']}
    try:
        result['data'] = aggregate(run(['system', 'df', '--format', '{{json .}}'], deadline))
        result.update(state='observed', collection_error=None)
        try:
            ids, count = candidates(run(['image', 'ls', '--all', '--no-trunc', '--format', '{{.ID}}\t{{.Size}}'], deadline))
            result['image_inventory_count'] = count
            result['largest_observed_images'] = largest(run(['image', 'inspect', '--format', '{{.Id}} {{.Size}}', *ids], deadline), ids) if ids else []
        except (OSError, ValueError, TypeError, KeyError, InvalidOperation, subprocess.SubprocessError):
            result.update(state='partial', largest_collection_error='largest_image_measurement_incomplete')
    except (OSError, ValueError, TypeError, KeyError, InvalidOperation, subprocess.SubprocessError):
        pass
    result['measurement_seconds'] = round(time.monotonic()-started, 3)
    return result


if __name__ == '__main__':
    import sys
    if sys.argv[1:] != ['report']:
        raise SystemExit('fixed_report_action_required')
    print(json.dumps(collect(), separators=(',', ':'), allow_nan=False))
