"""Bounded image archive transfer over the existing private PC transport."""
import base64, contextlib, gzip, hashlib, importlib.util, json, os, select, struct
import subprocess, sys, time
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
POLICY_PATH = ROOT / '.local-secrets/rollback-cloud-daily.json'
POLICY = json.loads(POLICY_PATH.read_text())
HERE = ROOT / '.local-state/rollback-cloud-daily/transport'
PC_ROOT = POLICY.get('pc_archive_root')
def desktop_transport():
    transport_path = ROOT / '.local-state/desktop-browser-tool/transport.py'
    expected = POLICY.get('existing_transport_sha256')
    if not isinstance(expected, str) or hashlib.sha256(transport_path.read_bytes()).hexdigest() != expected:
        raise ValueError('existing_desktop_transport_changed')
    spec = importlib.util.spec_from_file_location('existing_desktop_transport', transport_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    config = json.loads(module.CONFIG.read_text())['gpu_probe']
    return module, config


def remote(script):
    module, _ = desktop_transport()
    return module.remote(script)


COMPRESSED_LIMIT = 0

def record(name, value):
    HERE.mkdir(parents=True, exist_ok=True, mode=448)
    path = HERE / name
    with path.open('x') as f:
        json.dump(value, f, indent=2)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())
    fd = os.open(HERE, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def docker(*args):
    r = subprocess.run(['docker', *args], capture_output=True, timeout=20)
    if r.returncode:
        raise RuntimeError('docker_read_failed')
    return r.stdout

def in_use(image):
    ids = docker('ps', '-aq').decode().split()
    return bool(ids and 'sha256:' + image in docker('inspect', '--format', '{{.Image}}', *ids).decode().split())

def ssh_argv():
    _, c = desktop_transport()
    return ['docker', 'exec', '-i', c['container'], 'ssh', '-T', '-i', c['ssh_key_path'], '-p', str(c['ssh_port']), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(Path(c['ssh_key_path']).parent / 'known_hosts'), '-o', 'ConnectTimeout=5', c['ssh_user'] + '@' + c['ssh_host']]

def string(b):
    if isinstance(b, str):
        b = b.encode()
    return struct.pack('>I', len(b)) + b

class SFTP:

    def __init__(self):
        self.p = subprocess.Popen(ssh_argv()[:-1] + ['-s', ssh_argv()[-1], 'sftp'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.sequence = 0
        self.send(1, struct.pack('>I', 3))
        kind, payload = self.receive()
        assert kind == 2

    def send(self, kind, payload):
        packet = bytes([kind]) + payload
        self.p.stdin.write(struct.pack('>I', len(packet)) + packet)
        self.p.stdin.flush()

    def exact(self, n):
        b = bytearray()
        while len(b) < n:
            if not select.select([self.p.stdout], [], [], 30)[0]:
                raise TimeoutError('sftp_response_timeout')
            c = os.read(self.p.stdout.fileno(), n - len(b))
            if not c:
                raise RuntimeError('sftp_short_read')
            b.extend(c)
        return bytes(b)

    def receive(self):
        n = struct.unpack('>I', self.exact(4))[0]
        assert n < 1024 * 1024
        b = self.exact(n)
        return (b[0], b[1:])

    def request(self, kind, payload):
        self.sequence += 1
        self.send(kind, struct.pack('>I', self.sequence) + payload)
        k, b = self.receive()
        assert struct.unpack('>I', b[:4])[0] == self.sequence
        return (k, b[4:])

    def open(self, path, flags):
        k, b = self.request(3, string('/' + path) + struct.pack('>II', flags, 0))
        if k != 102:
            raise RuntimeError('sftp_open_refused')
        n = struct.unpack('>I', b[:4])[0]
        return b[4:4 + n]

    def close_handle(self, h):
        k, b = self.request(4, string(h))
        assert k == 101 and struct.unpack('>I', b[:4])[0] == 0

    def write(self, h, offset, data):
        k, b = self.request(6, string(h) + struct.pack('>Q', offset) + string(data))
        assert k == 101 and struct.unpack('>I', b[:4])[0] == 0

    def read(self, h, offset, length):
        k, b = self.request(5, string(h) + struct.pack('>QI', offset, length))
        if k == 101:
            assert struct.unpack('>I', b[:4])[0] == 1
            return b''
        assert k == 103
        n = struct.unpack('>I', b[:4])[0]
        return b[4:4 + n]

    def close(self):
        self.p.stdin.close()
        try:
            self.p.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.p.terminate()
            self.p.wait(timeout=3)

class RemoteWriter:

    def __init__(self, sftp, handle):
        self.sftp = sftp
        self.handle = handle
        self.n = 0
        self.hash = hashlib.sha256()

    def write(self, data):
        for start in range(0, len(data), 65536):
            part = data[start:start + 65536]
            if self.n + len(part) > COMPRESSED_LIMIT:
                raise ValueError('compressed_cycle_quota_exceeded')
            self.sftp.write(self.handle, self.n, part)
            self.hash.update(part)
            self.n += len(part)
        return len(data)

    def flush(self):
        pass

def export(image):
    if not isinstance(PC_ROOT, str) or not __import__('re').fullmatch(r'[A-Za-z]:/[A-Za-z0-9_./ -]+', PC_ROOT) or '..' in PC_ROOT.split('/'):
        raise ValueError('fixed_pc_root_invalid')
    assert not in_use(image)
    before = json.loads(docker('image', 'inspect', 'sha256:' + image))[0]
    assert before['Id'] == 'sha256:' + image
    name = image + '.docker.tar.gz'
    path = PC_ROOT + '/' + name
    record(image + '-EXPORT-INTENT.json', {'image_id': before['Id'], 'repo_digests': before['RepoDigests'], 'source_bytes': before['Size'], 'pc_file': path, 'started_at': time.time(), 'host_staging_bytes': 0})
    r = remote("$ErrorActionPreference='Stop';[IO.Directory]::CreateDirectory('" + PC_ROOT.replace("'", "''") + "')|Out-Null; [pscustomobject]@{state='directory_ready'}|ConvertTo-Json -Compress")
    assert r.get('state') == 'directory_ready'
    s = SFTP()
    h = s.open(path, 2 | 8 | 32)
    writer = RemoteWriter(s, h)
    p = subprocess.Popen(['nice', '-n', '19', 'ionice', '-c', '3', 'docker', 'image', 'save', 'sha256:' + image], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    started = time.monotonic()
    raw = 0
    try:
        with gzip.GzipFile(filename='', fileobj=writer, mode='wb', compresslevel=1, mtime=0) as packed:
            while (chunk := p.stdout.read(256 * 1024)):
                packed.write(chunk)
                raw += len(chunk)
                wait = raw / (16 * 1024 * 1024) - (time.monotonic() - started)
                if wait > 0:
                    time.sleep(wait)
        assert p.wait(timeout=30) == 0
        s.close_handle(h)
    finally:
        if p.poll() is None:
            p.terminate()
            p.wait(timeout=5)
        s.close()
    expected = writer.hash.hexdigest()
    ps = "$ErrorActionPreference='Stop';$p='" + path + "';$stream=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read);try{$stream.Flush($true)}finally{$stream.Dispose()};$f=Get-Item -LiteralPath $p;$h=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant();[pscustomobject]@{state='pc_archive_observed';bytes=$f.Length;sha256=$h}|ConvertTo-Json -Compress"
    verified = remote(ps)
    assert verified.get('sha256') == expected and verified.get('bytes') == writer.n
    result = {'image_id': image, 'pc_file': path, 'bytes': writer.n, 'sha256': expected, 'raw_tar_bytes': raw, 'state': 'pc_archive_hash_verified', 'at': time.time()}
    record(image + '-PC-VERIFIED.json', result)
    return result
