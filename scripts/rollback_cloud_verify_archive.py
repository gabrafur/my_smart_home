import gzip, hashlib, json, pathlib, tarfile, sys
p = pathlib.Path(sys.argv[1])
image = sys.argv[2]
assert p.parent == pathlib.Path(sys.argv[3])
assert p.name == image + '.docker.tar.gz'
count = 0
manifest = None
configs = {}
digests = set()
with tarfile.open(p, 'r|gz') as archive:
    for entry in archive:
        assert entry.isfile() or entry.isdir()
        assert not entry.name.startswith('/') and '..' not in pathlib.PurePosixPath(entry.name).parts
        if not entry.isfile():
            continue
        f = archive.extractfile(entry)
        digest = hashlib.sha256()
        value = bytearray()
        if entry.name == 'manifest.json':
            assert entry.size < 1024 * 1024
            manifest = json.load(f)
            continue
        is_config = entry.size <= 4 * 1024 * 1024
        if is_config:
            assert entry.size <= 4 * 1024 * 1024
        while (b := f.read(1024 * 1024)):
            digest.update(b)
            if is_config:
                value.extend(b)
        if entry.name.startswith('blobs/sha256/'):
            assert digest.hexdigest() == entry.name.rsplit('/', 1)[1]
            digests.add(digest.hexdigest())
            count += 1
        if is_config:
            try:
                config = json.loads(value)
            except (ValueError, UnicodeError):
                continue
            configs[entry.name] = config
assert isinstance(manifest, list) and len(manifest) == 1
row = manifest[0]
assert row['Config'] in configs
config = configs[row['Config']]
assert config['architecture'] == 'arm64'
if 'blobs/sha256/' + image in configs:
    pending = [image]
    visited = set()
    reachable = set()
    while pending:
        key = pending.pop()
        if key in visited:
            continue
        visited.add(key)
        assert len(visited) < 64
        obj = configs.get('blobs/sha256/' + key, {})
        refs = obj.get('manifests', []) + ([obj['config']] if 'config' in obj and isinstance(obj['config'], dict) and ('digest' in obj['config']) else [])
        for ref in refs:
            digest = ref['digest']
            assert digest.startswith('sha256:')
            value = digest.split(':', 1)[1]
            reachable.add(value)
            pending.append(value)
    assert row['Config'].rsplit('/', 1)[1] in reachable or row['Config'] == 'blobs/sha256/' + image
else:
    assert row['Config'] == image + '.json'
assert all((x.startswith('blobs/sha256/') and x.rsplit('/', 1)[1] in digests for x in row['Layers']))
assert len(row['Layers']) == len(configs[row['Config']]['rootfs']['diff_ids'])
print(json.dumps({'state': 'docker_archive_manifest_and_blobs_verified', 'image_id': image, 'layer_count': len(row['Layers']), 'blob_count': count, 'architecture': 'arm64', 'runtime_load_tested': False}))
