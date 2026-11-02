"""Fixed metadata-only collector post-step; private, not installed or enabled."""
import hashlib,json,os,signal,stat,sys,time,types
from pathlib import Path
LIB=Path('/usr/local/lib/raspberry-task-terminal-observer')
CONFIG=LIB/'config.json'
NAMES={'observer.py','native_adapter.py','bootstrap.py'}

def need(ok,why):
    if not ok:raise ValueError(why)
def root_read(path):
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for part in path.parts[1:-1]:
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=child
            s=os.fstat(fd);need(s.st_uid==s.st_gid==0 and not s.st_mode&0o022,'root_ancestor_changed')
        leaf=os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
    finally:os.close(fd)
    try:
        s=os.fstat(leaf);need(stat.S_ISREG(s.st_mode) and s.st_uid==s.st_gid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o644 and 0<s.st_size<=65536,'root_source_changed')
        raw=os.read(leaf,65537);a=os.fstat(leaf)
        need((s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)==(a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns) and len(raw)==s.st_size,'root_source_changed_during_read');return raw
    finally:os.close(leaf)
def decode(raw):
    def unique(rows):
        d={}
        for k,v in rows:need(k not in d,'duplicate_config_key');d[k]=v
        return d
    return json.loads(raw,object_pairs_hook=unique,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('nonfinite_json')))
def module(name,raw,path):
    m=types.ModuleType(name);m.__file__=str(path);sys.modules[name]=m;exec(compile(raw,str(path),'exec'),m.__dict__);return m

def run(digest):
    need(os.geteuid()==1001 and len(digest)==64 and all(c in '0123456789abcdef' for c in digest),'fixed_observer_identity_required')
    raw=root_read(CONFIG);need(hashlib.sha256(raw).hexdigest()==digest,'observer_config_changed')
    cfg=decode(raw)
    need(type(cfg) is dict and set(cfg)=={'schema_version','enabled','scope_started_at','source_hashes'} and type(cfg['schema_version']) is int and cfg['schema_version']==1 and cfg['enabled'] is True and type(cfg['scope_started_at']) is int and 0<=cfg['scope_started_at']<=time.time() and type(cfg['source_hashes']) is dict and set(cfg['source_hashes'])==NAMES,'observer_config_scope_changed')
    sources={name:root_read(LIB/name) for name in NAMES}
    need(all(type(cfg['source_hashes'][name]) is str and hashlib.sha256(sources[name]).hexdigest()==cfg['source_hashes'][name] for name in NAMES),'observer_source_digest_changed')
    o=module('task_terminal_observer',sources['observer.py'],LIB/'observer.py')
    adapter=module('task_terminal_native_adapter',sources['native_adapter.py'],LIB/'native_adapter.py')
    scope=cfg['scope_started_at']
    def revoked():
        return os.path.lexists('/var/lib/raspberry-mcp-operations/task-control/revoked')
    rows=lambda:o.production_rows(scope)
    transport=adapter.Adapter(rows)
    def check():
        need(not revoked(),'task_observation_revoked');return transport.policy_check()
    def expired(_sig,_frame):raise TimeoutError('observer_deadline')
    previous=signal.signal(signal.SIGALRM,expired);signal.setitimer(signal.ITIMER_REAL,1.85)
    try:
        report=o.collect(rows,check,transport,scope_started_at=scope,budget_seconds=1.8)
    except Exception:
        report=o.public_snapshot({'observed_at':time.time(),'state':'unknown','collection_error':'observation_deadline_or_source_unconfirmed','pending':None,'terminal_unreconciled':[]},scope)
    finally:
        signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous)
    o.publish_snapshot(report)
    return report['state']
if __name__=='__main__':
    try:
        need(len(sys.argv)==2,'fixed_config_digest_required');run(sys.argv[1])
    except Exception:
        # No operation/daemon paths, stdout, prompts, arguments or credentials.
        os.write(2,b'task_terminal_observation_unconfirmed\n')
        raise SystemExit(0)
