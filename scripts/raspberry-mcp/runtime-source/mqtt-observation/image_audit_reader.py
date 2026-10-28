"""Bounded Root witness for one isolated broker image, never residential IPC."""
from pathlib import Path
import json,os,re,resource,select,stat,sys,time

def need(value):
    if not value:raise RuntimeError('image_audit_witness_unconfirmed')

def main():
    need(os.geteuid()==os.getegid()==0)
    if len(sys.argv)==2:
        os.execv('/usr/bin/setpriv',['setpriv','--no-new-privs','--inh-caps=-all','--ambient-caps=-all',
          '--bounding-set=-all,+chown,+dac_read_search,+sys_ptrace','/usr/bin/python3','-I','-S','-B',
          str(Path(__file__).resolve()),'capped',sys.argv[1]])
    need(len(sys.argv)==3 and sys.argv[1]=='capped')
    fixture=Path(sys.argv[2]);need(fixture.is_absolute()and fixture.resolve()==fixture
      and re.fullmatch('mqtt-image-audit-[a-f0-9]{32}',fixture.name))
    for p,mode in [(fixture,0o711),(fixture/'ipc',0o755),(fixture/'state',0o700),(Path(__file__).parent,0o755)]:
        s=p.lstat();need(stat.S_ISDIR(s.st_mode)and(s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode))==(0,0,mode))
    q=fixture/'request.json';s=q.lstat();need(stat.S_ISREG(s.st_mode)and s.st_nlink==1
      and(s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode))==(0,0,0o600)and s.st_size<=4096)
    request=json.loads(q.read_bytes());need(set(request)=={'container_id','binary_sha256','plugin_sha256','approval_sha256','expires_at'})
    need(all(type(request[k])is str and re.fullmatch('[a-f0-9]{64}',request[k])for k in request if k!='expires_at'))
    need(type(request['expires_at'])in(int,float)and time.time()<request['expires_at']<=time.time()+125)
    caps={k:v.strip()for k,v in(x.split(':',1)for x in Path('/proc/self/status').read_text().splitlines()if ':'in x)}
    need(all(int(caps[k],16)==0x80005 for k in ['CapPrm','CapEff','CapBnd'])
      and int(caps['CapInh'],16)==int(caps['CapAmb'],16)==0 and caps['NoNewPrivs']=='1')
    resource.setrlimit(resource.RLIMIT_AS,(134217728,134217728));resource.setrlimit(resource.RLIMIT_CPU,(20,20))
    sys.path.insert(0,str(Path(__file__).parent))
    from authorization_gate import AuthorizationGate,SCOPE
    from receiver_ledger import Ledger
    from source_binding import SourceVerifier,SourcePolicy,local_clock_domain,sender_pidfd_pid
    from socket_reader import SocketReader,PacketIntake
    authorization=fixture/'state/authorization.json'
    with authorization.open('x')as f:json.dump({'version':1,'scope':SCOPE,'enabled':True,
      'expires_at':request['expires_at'],'approval_id':request['approval_sha256']},f)
    authorization.chmod(0o600)
    gate=ledger=verifier=reader=None;deadline=time.monotonic()+120
    def emit(value):print(json.dumps(value),flush=True)
    def step(wait=.05):
        need(time.monotonic()<deadline and gate.refresh()['source_authorized']is True)
        if select.select([reader.sock],[],[],wait)[0]:
            for _ in range(16):
                value=reader.receive()
                if value is None:break
                need(value['status']in('accepted','duplicate'))
    try:
        gate=AuthorizationGate(fixture/'ipc',authorization);need(gate.refresh()['source_authorized']is True)
        ledger=Ledger(fixture/'state/witness.sqlite3',create=True,clock_domain_id=local_clock_domain(),
                      started_ns=time.clock_gettime_ns(time.CLOCK_BOOTTIME))
        verifier=SourceVerifier(SourcePolicy(request['container_id'],1883,1883,request['binary_sha256'],
          request['plugin_sha256'],'/mosquitto/metadata/observer.so',0))
        reader=SocketReader(fixture/'ipc/source.sock',group_gid=1883,
          intake=PacketIntake(ledger,verifier,require_sender_pidfd=True))
        emit({'stage':'ready'})
        while ledger.body['accepted_frames']<2:step()
        emit({'stage':'live_verified'})
        while not(ledger.body['state']and all(row['observed']>0 for row in ledger.body['state']['stats'].values())):step()
        emit({'stage':'seven_classes_observed'})
        while not(fixture/'pause').exists():step()
        emit({'stage':'intake_paused'})
        while not(fixture/'broker-exited').exists():
            need(time.monotonic()<deadline and gate.refresh()['source_authorized']is True);time.sleep(.03)
        need(sender_pidfd_pid(verifier.sender_fd)==-1)
        before=ledger.body['accepted_frames']
        while select.select([reader.sock],[],[],0)[0]:step(0)
        s=ledger.body['state'];need(s is not None and s['source_closed']is True
          and s['last_source_wire_version']==3 and s['unknown_epoch_tails']==0
          and ledger.body['accepted_frames']>before and not any(ledger.body['faults'].values()))
        need(all(row['observed']>0 and row['missing']==row['timing_unknown']==0 for row in s['stats'].values()))
        emit({'stage':'verified','wire_version':3,'source_epoch':str(s['epoch']),
          'verified_frames':str(ledger.body['accepted_frames']),'post_exit_frames':str(ledger.body['accepted_frames']-before),
          'source_closed':True,'sender_pidfd_exited':True,'unknown_epoch_tails':'0',
          'seven_classes':{k:{n:str(row[n])for n in ['observed','missing','timing_unknown']}for k,row in s['stats'].items()},
          'caps':{k:caps[k]for k in ['CapPrm','CapEff','CapBnd','CapInh','CapAmb','NoNewPrivs']},
          'Root_hard_AS_bytes':134217728,'residential_data':False,'full24h_proven':False})
    finally:
        for value in [reader,verifier,ledger,gate]:
            if value is not None:value.close()

if __name__=='__main__':
    try:main()
    except Exception:print('{"stage":"unconfirmed","reason":"image_audit_witness_unconfirmed"}',flush=True);raise SystemExit(1)
