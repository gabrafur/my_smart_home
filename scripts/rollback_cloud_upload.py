import hashlib, json, os, subprocess, threading, time
from pathlib import Path
from rollback_cloud_transport import HERE, SFTP, record

def upload(image, archive=None):
    row = archive if archive is not None else json.loads((HERE / (image + '-PC-VERIFIED.json')).read_text())
    assert row['image_id'] == image
    record(image + '-CLOUD-INTENT.json', {'image_id': image, 'archive_sha256': row['sha256'], 'staging': 'local' if 'local_file' in row else 'pc', 'bytes': row['bytes'], 'at': time.time()})
    source = Path(__file__).with_name('rollback_cloud_worker.py').read_text()
    p = subprocess.Popen(['docker', 'exec', '-i', 'homeassistant', 'python', '-c', source, json.dumps(row)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    errors = []

    def send():
        s = None
        local_fd = None
        try:
            if 'local_file' in row:
                from rollback_cloud_local import open_verified_archive
                local_fd = open_verified_archive(row)
            else:
                s = SFTP()
                h = s.open(row['pc_file'], 1)
            n = 0
            digest = hashlib.sha256()
            while n < row['bytes']:
                length = min(65536, row['bytes'] - n)
                b = os.read(local_fd, length) if local_fd is not None else s.read(h, n, length)
                assert b
                n += len(b)
                digest.update(b)
                p.stdin.write(b)
            assert digest.hexdigest() == row['sha256']
            if s:
                s.close_handle(h)
            p.stdin.close()
        except Exception as e:
            errors.append(type(e).__name__)
        finally:
            if local_fd is not None:
                os.close(local_fd)
            if s:
                s.close()
            if p.stdin is not None and not p.stdin.closed:
                p.stdin.close()
    t = threading.Thread(target=send, daemon=True)
    t.start()
    t.join(1800)
    if t.is_alive():
        raise RuntimeError('upload_result_uncertain_inspect_same_cloud_name')
    p.stdin = None
    out, err = p.communicate(timeout=1800)
    record(image + '-CLOUD-RESULT.json', {'returncode': p.returncode, 'writer_errors': errors, 'stderr_sha256': hashlib.sha256(err).hexdigest(), 'stdout': out.decode(errors='replace'), 'at': time.time()})
    result = json.loads(out)
    assert p.returncode == 0 and (not errors)
    assert result['state'] == 'cloud_roundtrip_sha256_verified' and result['sha256'] == row['sha256'] and (result['bytes'] == row['bytes'])
    record(image + '-CLOUD-VERIFIED.json', result)
    return result
