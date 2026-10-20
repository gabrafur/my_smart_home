"""Fixed-target project broker. No shell, arbitrary paths, URLs or credentials."""
import datetime as dt
import difflib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import stat
import struct
import subprocess
import sys
import time
import uuid

ROOT = Path('/mnt/data/docker')
STATE = Path('/var/lib/raspberry-mcp-operations')
MANIFEST = Path('/usr/local/lib/raspberry-mcp/project-catalog.json')
SERVICES = ('homeassistant', 'nodered', 'mosquitto')
MAX_FILE = 262144
FIELDS = {
    'project_files': ('category', 'offset'),
    'project_read': ('file_id', 'offset'),
    'project_prepare_edit': ('file_id', 'expected_sha256', 'old_text', 'new_text'),
    'service_prepare_restart': ('service',),
    'change_apply': ('change_id',),
    'change_revert': ('change_id',),
}

def digest(data):
    return hashlib.sha256(data).hexdigest()

def allowed(path):
    parts = path.split('/')
    if any(not p or p in ('.', '..') or p.startswith('.') for p in parts):
        return False
    return (path.startswith('docs/') and len(parts) == 2 and path.endswith('.md')
            or path.startswith('nodered/tools/functions/') and len(parts) == 4 and path.endswith('.js')
            or path.startswith('homeassistant/dashboards/') and len(parts) == 3 and path.endswith('.yaml'))

def clean_text(data):
    if len(data) > MAX_FILE or b'\x00' in data:
        raise ValueError('file_not_supported')
    text = data.decode('utf-8')
    # Fail closed for credential-shaped material; no attempt to redact and edit it.
    if re.search(r'(?i)(-----BEGIN [A-Z ]*PRIVATE KEY|\b(?:sk-[a-zA-Z0-9_-]{20,}|gh[pousr]_[a-zA-Z0-9]{20,})|(?:password|token|client_secret|api_key)\s*[:=]\s*[\"\x27]?[a-zA-Z0-9_+/-]{16,}|\beyJ[a-zA-Z0-9_-]{20,}\.)', text):
        raise ValueError('sensitive_content_blocked')
    return text

def parent_fd(root, relative):
    if not allowed(relative):
        raise ValueError('target_not_allowed')
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in relative.split('/')[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except Exception:
        os.close(fd)
        raise

def read_at(fd, name):
    source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        info = os.fstat(source)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > MAX_FILE:
            raise ValueError('file_not_supported')
        data = os.read(source, MAX_FILE + 1)
        clean_text(data)
        return data, info
    finally:
        os.close(source)

def restart(service):
    if service not in SERVICES:
        raise ValueError('invalid_parameters')
    result = subprocess.run(['/usr/bin/docker', 'restart', '--time', '20', service],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env={'PATH': '/usr/bin:/bin', 'DOCKER_HOST': 'unix:///var/run/docker.sock'}, timeout=45)
    return result.returncode == 0

class Broker:
    def __init__(self, root, state, catalog, restart_fn=restart):
        self.root, self.state, self.catalog, self.restart_fn = root, state, catalog, restart_fn

    def save(self, name, value):
        target = self.state / name
        temp = self.state / (uuid.uuid4().hex + '.tmp')
        with temp.open('x', encoding='utf-8') as stream:
            os.chmod(temp, 0o600)
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, target)

    def load(self, name):
        return json.loads((self.state / name).read_text())

    def source(self, file_id):
        if file_id not in self.catalog:
            raise ValueError('target_not_allowed')
        item = self.catalog[file_id]
        fd = parent_fd(self.root, item['path'])
        try:
            data, info = read_at(fd, item['path'].split('/')[-1])
        finally:
            os.close(fd)
        accepted = item['sha256']
        marker = self.state / ('accepted-' + file_id + '.json')
        if marker.exists():
            accepted = self.load(marker.name)['sha256']
        if digest(data) != accepted:
            raise ValueError('local_changes_detected')
        return item, data

    def proposal(self, value):
        if len(list(self.state.glob('change-*.json'))) >= 64:
            raise ValueError('proposal_capacity_reached')
        key = uuid.uuid4().hex
        value.update(created_at=time.time(), status='prepared')
        self.save('change-' + key + '.json', value)
        return key

    def handle(self, name, args):
        if name not in FIELDS or not isinstance(args, dict) or set(args) != {'host', *FIELDS[name]} or args['host'] != 'raspberry':
            raise ValueError('invalid_parameters')
        for k in ('file_id', 'change_id', 'expected_sha256'):
            if k in args and (not isinstance(args[k], str) or not re.fullmatch('[a-f0-9]{' + ('64' if k == 'expected_sha256' else '32') + '}', args[k])):
                raise ValueError('invalid_parameters')
        if 'offset' in args and (type(args['offset']) is not int or not 0 <= args['offset'] <= MAX_FILE):
            raise ValueError('invalid_parameters')
        if name == 'project_files':
            category = args['category']
            if category not in ('docs', 'nodered', 'homeassistant'):
                raise ValueError('invalid_parameters')
            items = [{'file_id': key, 'path': row['path']} for key, row in self.catalog.items() if row['path'].split('/')[0] == category]
            offset = args['offset']
            return {'files': items[offset:offset+30], 'next_offset': offset+30 if offset+30 < len(items) else None, 'total': len(items)}
        if name in ('project_read', 'project_prepare_edit'):
            item, data = self.source(args['file_id'])
            text = clean_text(data)
            if name == 'project_read':
                offset = args['offset']
                return {'path': item['path'], 'sha256': digest(data), 'text': text[offset:offset+4000], 'next_offset': offset+4000 if offset+4000 < len(text) else None, 'deployment': 'source_only'}
            if args['expected_sha256'] != digest(data):
                raise ValueError('conflict')
            old, new = args['old_text'], args['new_text']
            if not isinstance(old, str) or not isinstance(new, str) or not old or max(len(old), len(new)) > 4000 or old == new or text.count(old) != 1:
                raise ValueError('replacement_must_match_once')
            replacement = text.replace(old, new, 1).encode()
            clean_text(replacement)
            preview = ''.join(difflib.unified_diff(text.splitlines(True), replacement.decode().splitlines(True), fromfile=item['path'], tofile=item['path']))
            if len(preview) > 10000:
                raise ValueError('preview_too_large')
            key = self.proposal({'kind': 'file', 'file_id': args['file_id'], 'before': text, 'after': replacement.decode(), 'base': digest(data), 'result': digest(replacement)})
            return {'change_id': key, 'preview': preview, 'expires_in_seconds': 3600, 'deployment': 'source_only_no_reload_no_tests_executed', 'apply_available': False, 'apply_blocked_reason': 'atomic_compare_replace_unavailable'}
        if name == 'service_prepare_restart':
            if args['service'] not in SERVICES:
                raise ValueError('invalid_parameters')
            key = self.proposal({'kind': 'restart', 'service': args['service']})
            return {'change_id': key, 'service': args['service'], 'effect': 'restart_one_container_brief_interruption', 'expires_in_seconds': 3600}
        key = 'change-' + args['change_id'] + '.json'
        row = self.load(key)
        reverting = name == 'change_revert'
        if row['status'] == ('reverted' if reverting else 'applied'):
            if row['kind'] == 'file':
                raise ValueError('atomic_compare_replace_unavailable')
            return {'status': row['status'], 'replayed': True}
        if reverting and (row['kind'] != 'file' or row['status'] != 'applied'):
            raise ValueError('revert_not_available')
        if not reverting and (row['status'] != 'prepared' or time.time()-row['created_at'] > 3600):
            raise ValueError('proposal_expired_or_consumed')
        if row['kind'] == 'restart':
            row['status'] = 'executing'
            self.save(key, row)  # Never blindly retry after timeout or interrupted response.
            try:
                success = self.restart_fn(row['service'])
            except Exception:
                success = False
            row['status'] = 'applied' if success else 'outcome_unknown'
            self.save(key, row)
            return {'status': row['status'], 'service': row['service'], 'verify_with': 'service_health_after_snapshot_refresh'}
        item, data = self.source(row['file_id'])
        expected = row['result'] if reverting else row['base']
        content = (row['before'] if reverting else row['after']).encode()
        if digest(data) != expected:
            raise ValueError('conflict')
        # No file mutation until writer exclusion can be enforced.
        raise ValueError('atomic_compare_replace_unavailable')
        fd = parent_fd(self.root, item['path'])
        name = item['path'].split('/')[-1]
        temp = '.mcp-' + uuid.uuid4().hex
        try:
            current, info = read_at(fd, name)
            if digest(current) != expected:
                raise ValueError('conflict')
            if info.st_uid != os.geteuid():
                raise ValueError('file_owner_not_supported')
            out = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, stat.S_IMODE(info.st_mode) & 0o666, dir_fd=fd)
            try:
                os.fchown(out, info.st_uid, info.st_gid)
                os.fchmod(out, stat.S_IMODE(info.st_mode) & 0o777)
                with os.fdopen(out, 'wb') as stream:
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
                if digest(read_at(fd, name)[0]) != expected:
                    raise ValueError('conflict')
                os.replace(temp, name, src_dir_fd=fd, dst_dir_fd=fd)
                os.fsync(fd)
            finally:
                try:
                    os.unlink(temp, dir_fd=fd)
                except FileNotFoundError:
                    pass
        finally:
            os.close(fd)
        self.save('accepted-' + row['file_id'] + '.json', {'sha256': digest(content)})
        row['status'] = 'reverted' if reverting else 'applied'
        self.save(key, row)
        return {'status': row['status'], 'path': item['path'], 'sha256': digest(content), 'deployment': 'source_only_no_restart_no_commit'}

def main():
    import pwd
    connection = socket.socket(fileno=os.dup(0))
    _, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    if uid != pwd.getpwnam('raspberry-mcp').pw_uid:
        return
    connection.settimeout(8)
    payload = bytearray()
    while b'\n' not in payload:
        part = connection.recv(4096)
        if not part:
            return
        payload.extend(part)
        if len(payload) > 16384:
            return
    outcome, tool = 'rejected', 'none'
    try:
        request = json.loads(payload)
        if set(request) != {'name', 'arguments'}:
            raise ValueError('invalid_parameters')
        tool = request['name'] if request['name'] in FIELDS else 'none'
        with (STATE / 'lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = Broker(ROOT, STATE, json.loads(MANIFEST.read_text())).handle(request['name'], request['arguments'])
        response = {'ok': True, 'result': result}
        outcome = 'ok'
    except Exception as error:
        safe = str(error) if isinstance(error, ValueError) and re.fullmatch('[a-z_]{1,60}', str(error)) else 'operation_unavailable'
        response = {'ok': False, 'error': safe}
    sys.stderr.write(json.dumps({'time': dt.datetime.now(dt.timezone.utc).isoformat(), 'tool': tool, 'outcome': outcome})+'\n')
    connection.sendall((json.dumps(response)+'\n').encode())

if __name__ == '__main__':
    main()
