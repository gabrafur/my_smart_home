"""Owner-authorized fixed daily backend using the existing PC and HA transport."""
import base64
from datetime import datetime
import hashlib
import json
import os
import time
from pathlib import Path
import subprocess
import rollback_cloud_transport as transport
from rollback_cloud_upload import upload

ROOT = Path(__file__).resolve().parent.parent


def snapshot(image_id):
    value = transport.docker('image', 'inspect', '--format',
                             '{{json .Id}}\t{{json .Created}}\t{{json .RepoTags}}\t{{json .RepoDigests}}', image_id)
    values = value.decode().strip().split('\t')
    if len(values) != 4:
        raise ValueError('image_metadata_invalid')
    identity, created, tags, digests = map(json.loads, values)
    return {'image_id': identity, 'created_at': datetime.fromisoformat(created.replace('Z', '+00:00')).timestamp(),
            'tags': tags, 'digests': digests, 'rollback_in_use': False}


class Backend:
    def __init__(self, policy_check):
        self.ensure_policy = policy_check

    def wsl_running(self):
        result = transport.remote("$ErrorActionPreference='Stop';$names=@(& wsl.exe --list --running --quiet | ForEach-Object {($_ -replace [char]0,'').Trim()} | Where-Object {$_});if($LASTEXITCODE -ne 0){throw 'wsl_list_failed'};[pscustomobject]@{state='running_distributions';names=$names}|ConvertTo-Json -Compress")
        return result.get('state') == 'running_distributions' and transport.POLICY['existing_running_wsl_distribution'] in result.get('names', [])

    def repository_reference(self, identity):
        for value in (identity, identity.removeprefix('sha256:')):
            match = subprocess.run(['git', '-C', str(ROOT), 'grep', '--quiet', '--fixed-strings', '-e', value, '--', '.'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            if match.returncode not in (0, 1):
                raise ValueError('repository_reference_scan_failed')
            if match.returncode == 0:
                return True
        return False
    def resources(self):
        from rollback_cloud_local import free_bytes
        fields = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
        return {'available_memory_bytes': int(fields['MemAvailable'].split()[0]) * 1024,
                'load1': os.getloadavg()[0], 'local_free_bytes': free_bytes()}

    def staging_available(self):
        from rollback_cloud_local import free_bytes, START_FREE_BYTES
        self.local_staging = free_bytes() >= START_FREE_BYTES
        return self.local_staging or (transport.POLICY.get('allow_existing_pc_fallback') is True and self.pc_available())

    def pc_available(self):
        connection = None
        try:
            connection = transport.SFTP()
            return self.wsl_running()
        except (OSError, RuntimeError, TimeoutError, AssertionError):
            return False
        finally:
            if connection:
                connection.close()

    def inventory(self):
        recovery = [ROOT/'.local-secrets/docker-update-recovery.json', ROOT/'.local-state/docker-update-recovery.json']
        if any(path.exists() or path.with_name(path.name+'.tmp').exists() for path in recovery):
            raise ValueError('pending_docker_recovery_preserve_images')
        # Docker returns newest first. Bound inspection to 32 oldest dangling
        # entries, then run repository scans only for the two selected images.
        identities = list(dict.fromkeys(transport.docker('image', 'ls', '--all', '--filter', 'dangling=true', '--no-trunc', '--quiet').decode().split()))[-32:]
        containers = transport.docker('ps', '-aq').decode().split()
        if len(containers) > 512:
            raise ValueError('container_inventory_limit')
        protected = set(transport.docker('inspect', '--format', '{{.Image}}', *containers).decode().split()) if containers else set()
        references = transport.docker('compose', 'config', '--images').decode().split()
        if len(references) > 128:
            raise ValueError('compose_inventory_limit')
        for reference in references:
            protected.add(transport.docker('image', 'inspect', '--format', '{{.Id}}', reference).decode().strip())
        protected.update(transport.POLICY['protected_image_ids'])
        rows = [snapshot(identity) for identity in identities]
        from rollback_cloud_policy import select_images
        selected = select_images(rows, protected, time.time(), maximum_images=2)
        for row in selected:
            if self.repository_reference(row['image_id']):
                protected.add(row['image_id'])
        return selected, protected

    def export(self, row, maximum_bytes):
        from rollback_cloud_local import free_bytes, START_FREE_BYTES, export_local
        if free_bytes() >= START_FREE_BYTES:
            return export_local(row['image_id'], maximum_bytes)
        if not self.pc_available():
            raise ValueError('staging_unavailable')
        transport.COMPRESSED_LIMIT = maximum_bytes
        return transport.export(row['image_id'].removeprefix('sha256:'))

    def verify_archive(self, row):
        if 'local_file' in row:
            from rollback_cloud_local import verify_local
            return verify_local(row)
        if not self.wsl_running():
            raise ValueError('required_wsl_not_running')
        policy = transport.POLICY
        root = policy['pc_archive_root']
        linux_root = '/mnt/' + root[0].lower() + root[2:]
        image = row['image_id']
        source = Path(__file__).with_name('rollback_cloud_verify_archive.py').read_text()
        source = 'import sys\nsys.argv=' + repr(['verify', linux_root+'/'+image+'.docker.tar.gz', image, linux_root]) + '\n' + source
        loader = "import base64;exec(base64.b64decode('" + base64.b64encode(source.encode()).decode() + "'))"
        distro = policy['existing_running_wsl_distribution']
        if not __import__('re').fullmatch(r'[A-Za-z0-9_.-]+', distro):
            raise ValueError('wsl_identity_invalid')
        script = "$ErrorActionPreference='Stop';$code=" + json.dumps(loader) + ";$result=& wsl.exe --distribution '" + distro + "' --exec /usr/bin/python3 -I -S -B -c $code;if($LASTEXITCODE -ne 0){throw 'archive_format_failed'};$result"
        result = transport.remote(script)
        transport.record(image+'-FORMAT-VERIFIED.json', result)
        return result

    def upload_and_verify(self, archive):
        return upload(archive['image_id'], archive=archive)

    def cleanup_archive(self, archive, receipt):
        if 'local_file' in archive:
            from rollback_cloud_local import cleanup_local
            cleanup_local(archive, receipt)

    def still_retirable(self, before):
        rows, protected = self.inventory()
        matches = [row for row in rows if row['image_id'] == before['image_id']]
        return before['image_id'] not in protected and matches == [before] and not self.repository_reference(before['image_id'])

    def retire(self, image_id):
        # No force flag. Docker itself rejects in-use or multi-tag conflicts.
        transport.docker('image', 'rm', image_id)

    def image_present(self, image_id):
        return image_id in transport.docker('image', 'ls', '--all', '--no-trunc', '--quiet').decode().split()
