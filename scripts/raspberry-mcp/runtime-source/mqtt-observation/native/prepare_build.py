"""Prepare a new unprivileged build context from the exact upstream SDK blobs.

Downloads source headers and license texts only. Never builds, installs,
restarts a service or reads residential data. Existing destinations are refused.
"""
from pathlib import Path
import hashlib,json,os,sys,urllib.request

HERE=Path(__file__).resolve().parent
COMMIT='99fa50f30e325609394c324c8ff71cfbbe95d8ab'
PREFIX='https://raw.githubusercontent.com/eclipse-mosquitto/mosquitto/'+COMMIT+'/'
FILES={'LICENSE.txt','edl-v10','epl-v20','include/mosquitto/broker.h',
       'include/mosquitto/broker_plugin.h','include/mosquitto/defs.h',
       'include/mosquitto/mqtt_protocol.h'}

def verify(record,data):
    if type(data)is not bytes or type(record['bytes'])is not int or not 0<record['bytes']<=65536:
        raise ValueError('sdk_size_invalid')
    if len(data)!=record['bytes'] or hashlib.sha256(data).hexdigest()!=record['sha256']:
        raise ValueError('sdk_checksum_mismatch')
    blob=hashlib.sha1(b'blob '+str(len(data)).encode('ascii')+b'\0'+data).hexdigest()
    if blob!=record['git_blob_sha1']:raise ValueError('sdk_git_blob_mismatch')
    return data

def records():
    manifest=json.loads((HERE/'sdk-manifest.json').read_text())
    if manifest['commit']!=COMMIT or manifest['version']!='2.1.2':
        raise ValueError('sdk_release_invalid')
    rows=manifest['files']
    if len(rows)!=len(FILES) or {r['path']for r in rows}!=FILES:
        raise ValueError('sdk_file_set_invalid')
    if any(r['url']!=PREFIX+r['path']for r in rows):raise ValueError('sdk_source_invalid')
    return rows

def prepare(destination,fetch):
    destination=Path(destination)
    # mkdir refuses existing paths, including symlinks. No overwrite/recovery.
    destination.mkdir(mode=0o700)
    sdk=destination/'sdk';sdk.mkdir(mode=0o700)
    for row in records():
        raw=verify(row,fetch(row['url'],row['bytes']+1))
        target=sdk/row['path'];target.parent.mkdir(parents=True,exist_ok=True)
        with target.open('xb')as out:out.write(raw)
        target.chmod(0o644)
    for name in ['native_sender_authorized.c','fault_harness_authorized.c','Dockerfile','sdk-manifest.json']:
        with (destination/name).open('xb')as out:out.write((HERE/name).read_bytes())
    with (destination/'LICENSE.project').open('xb')as out:
        out.write((HERE.parents[4]/'LICENSE').read_bytes())
    return {'state':'build_context_prepared_not_installed','sdk_files':len(FILES),
            'sdk_commit':COMMIT,'directory':str(destination),'production_changes':False}

def fetch(url,limit):
    with urllib.request.urlopen(url,timeout=20)as response:return response.read(limit)

def main():
    if os.geteuid()==0:raise ValueError('run_without_sudo')
    if len(sys.argv)!=2:raise ValueError('usage: prepare_build.py NEW_BUILD_DIRECTORY')
    print(json.dumps(prepare(Path(sys.argv[1]).absolute(),fetch)))

if __name__=='__main__':main()
