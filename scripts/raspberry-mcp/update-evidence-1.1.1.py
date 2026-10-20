#!/usr/bin/env python3
"""Pinned single-module evidence update. No services or permissions changed."""
import fcntl,hashlib,json,os,pathlib,subprocess,sys
SOURCE=pathlib.Path('/mnt/data/docker/scripts/raspberry-mcp/maintenance_evidence.py')
TARGET=pathlib.Path('/usr/local/lib/raspberry-mcp/maintenance_evidence.py')
BACKUP=TARGET.with_name('maintenance_evidence.pre-1.1.1.py')
OLD='6ae953c5f22f477bab0c7dd62f4b25e16db6e51b91bb90085e8c5ec3c6622e57'
NEW='d0ecafdd2f410559e7d65abbb821fc8576b4a1e0f3507738decb1f1e03fd3a51'
def read(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        import stat
        if not stat.S_ISREG(os.fstat(fd).st_mode):raise RuntimeError('not_regular')
        return os.read(fd,262145)
    finally:os.close(fd)
def digest(data):return hashlib.sha256(data).hexdigest()
def preflight():
    data=read(SOURCE)
    if digest(data)!=NEW:raise RuntimeError('source_changed')
    if digest(read(TARGET)) not in (OLD,NEW):raise RuntimeError('installed_changed')
    return data
def replace(expected,data):
    temporary=TARGET.with_name('.evidence-1.1.1.tmp')
    with temporary.open('xb') as stream:
        try:
            stream.write(data);stream.flush();os.fsync(stream.fileno());os.fchmod(stream.fileno(),0o644)
            if digest(read(TARGET))!=expected:raise RuntimeError('concurrent_change')
            os.replace(temporary,TARGET)
            fd=os.open(TARGET.parent,os.O_DIRECTORY)
            try:os.fsync(fd)
            finally:os.close(fd)
        finally:
            if temporary.exists():temporary.unlink()
def verify():
    probe="import socket,json;s=socket.socket(socket.AF_UNIX);s.settimeout(15);s.connect('/run/raspberry-mcp/operations.sock');s.sendall(b'{\"name\":\"backup_results\",\"arguments\":{\"host\":\"raspberry\"}}\\n');r=json.loads(s.makefile().readline());assert r['ok'] and r['result']['schema_version']=='1.1.1';assert 'waiter_count' in r['result']['data']['git']['locks'][0]['data']"
    subprocess.run(['runuser','-u','raspberry-mcp','--','/usr/bin/python3','-B','-c',probe],capture_output=True,check=True,timeout=20)
    subprocess.run(['systemctl','is-active','--quiet','raspberry-mcp-tunnel.service','raspberry-mcp-operations.socket'],capture_output=True,check=True,timeout=10)
def main():
    if sys.argv[1:] not in ([],['--check']):raise RuntimeError('invalid_arguments')
    data=preflight()
    if sys.argv[1:]==['--check']:print('Evidence 1.1.1 preflight passed; no changes.');return
    if os.geteuid()!=0:raise RuntimeError('local_sudo_required')
    parent=TARGET.parent
    if parent.is_symlink() or parent.stat().st_uid!=0 or parent.stat().st_mode&0o022:raise RuntimeError('unsafe_parent')
    with open('/run/lock/raspberry-mcp-evidence-update.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        data=preflight()
        if digest(read(TARGET))==NEW:
            verify();print('MCP evidence 1.1.1 already applied; verified.');return
        old=read(TARGET)
        if BACKUP.exists() or BACKUP.is_symlink():
            if digest(read(BACKUP))!=OLD:raise RuntimeError('backup_changed')
        else:
            fd=os.open(BACKUP,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(fd,'wb') as stream:stream.write(old);stream.flush();os.fsync(stream.fileno())
        replace(OLD,data)
        try:verify()
        except Exception:
            # Never overwrite an intervening update during rollback.
            replace(NEW,read(BACKUP));raise
    print('MCP evidence 1.1.1 applied; broker verified; no services restarted.')
if __name__=='__main__':
    try:main()
    except Exception:raise SystemExit('Evidence update stopped; inspect locally. No secrets printed. Re-run --check to reconcile installed hashes.')
