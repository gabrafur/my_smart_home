"""Durable Root maintenance facts, including pre-effect intents.

No CLI, service control, Docker calls, schedules or automatic retries. The
separately approved controller must collect real facts; JSON cannot attest an
effect. Canonical Node-RED gates still decide whether continuity is acceptable.
"""
import copy,hashlib,json,re
from deployment_files import FileTransaction,DeploymentUnavailable

MAX_OPERATIONS=16
PHASES=('begin','armed','source_stop_intent','source_stopped','source_drained',
        'consumer_stop_intent','consumer_stopped','consumer_start_intent',
        'consumer_started','consumer_ready','source_start_intent','source_started',
        'new_source_verified','complete')
FROZEN_PHASES=('frozen_begin','frozen_complete')
BOOTSTRAP_PHASES=('bootstrap_begin','bootstrap_remote_intent','bootstrap_report_recorded')
REASONS=('authorization_closed','binding_changed','source_unknown','accounting_unknown',
         'consumer_not_ready','clock_changed','deadline','write_failed','effect_uncertain','operator_conflict')
INTENT={'binding_sha256':'h','expected_state_sha256':'h'}
FACTS={
 'bootstrap_begin':{'profile_sha256':'h','worker_manifest_sha256':'h','bootstrap_approval_sha256':'h',
  'baseline_policy_sha256':'h','baseline_manifest_sha256':'h','snapshot_operation_sha256':'h','deadline_ns':'u64'},
 'bootstrap_remote_intent':{'bundle_sha256':'h','request_sha256':'h','dispatch_completed':'false'},
 'bootstrap_report_recorded':{'report_sha256':'h','independent_acceptance':'false'},
 'frozen_begin':{'source_authorization_sha256':'h','source_approval_sha256':'h','source_authorization_state':'closed_source',
  'source_expires_at':'expiry','source_runtime_marker_present':'b','code_manifest_sha256':'h','profile_sha256':'h',
  'deadline_ns':'u64','metadata_integrity':'unknown','effects_dispatched':'false'},
 'frozen_complete':{'snapshot_manifest_sha256':'h','source_authorization_sha256':'h',
  'metadata_integrity':'unknown','effects_dispatched':'false'},
 'begin':{'purpose':'purpose','window_id_sha256':'h','code_manifest_sha256':'h',
  'reader_instance_sha256':'h','source_epoch':'u128','source_instance_sha256':'h','source_binding_sha256':'h',
  'consumer_instance_sha256':'h','consumer_binding_sha256':'h','consumer_checkpoint_sequence':'u64','accepted_frames':'u128','unknown_epoch_tails':'u128'},
 'armed':{'window_id_sha256':'h','consumer_checkpoint_sha256':'h','consumer_checkpoint_sequence':'u64'},
 'source_stop_intent':INTENT,
 'source_stopped':{'binding_sha256':'h','source_epoch':'u128','source_instance_sha256':'h',
  'container_state':'state','exit_code':'code','sender_pidfd_exited':'b'},
 'source_drained':{'source_epoch':'u128','source_instance_sha256':'h','source_closed':'b',
  'accepted_frames':'u128','acknowledged_frames':'u128','pending_packet':'b','active_counts_nonempty':'b',
  'unknown_epoch_tails':'u128','consumer_checkpoint_sha256':'h','consumer_checkpoint_sequence':'u64',
  'protocol_counts_sha256':'h','reader_instance_sha256':'h'},
 'consumer_stop_intent':INTENT,
 'consumer_stopped':{'binding_sha256':'h','container_state':'state','exit_code':'code',
  'consumer_checkpoint_sequence':'u64'},
 'consumer_start_intent':INTENT,
 'consumer_started':{'binding_sha256':'h','start_boundary_ns':'u64'},
 'consumer_ready':{'binding_sha256':'h','consumer_instance_sha256':'h','consumer_checkpoint_sha256':'h',
  'consumer_checkpoint_sequence':'u64','reader_instance_sha256':'h','reader_observed_ns':'u64',
  'old_source_epoch':'u128','old_source_instance_sha256':'h','source_closed':'b','source_identity':'identity',
  'protocol_counts_sha256':'h'},
 'source_start_intent':INTENT,
 'source_started':{'binding_sha256':'h','start_boundary_ns':'u64'},
 'new_source_verified':{'source_epoch':'u128','source_instance_sha256':'h','binding_sha256':'h',
  'started_ns':'u64','covered_before_ns':'u64','accepted_frames':'u128','reader_instance_sha256':'h'},
 'complete':{'source_epoch':'u128','source_instance_sha256':'h','binding_sha256':'h','acknowledged_frames':'u128',
  'consumer_checkpoint_sha256':'h','consumer_checkpoint_sequence':'u64','protocol_counts_sha256':'h'},
 'failed':{'reason':'reason'},
 'cancelled':{'reason':'reason','no_effects_dispatched':'b'},
 'rescued':{'reason':'reason','rescue_receipt_sha256':'h','metadata_disabled':'b'},
}
class MaintenanceUnavailable(RuntimeError):pass
def need(ok,code='maintenance_record_invalid'):
    if not ok:raise MaintenanceUnavailable(code)
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode('ascii')
def digest(v):return hashlib.sha256(canonical(v)).hexdigest()
def hex64(v):return type(v)is str and re.fullmatch('[a-f0-9]{64}',v)is not None
def uint(v,bits):
    need(type(v)is str and re.fullmatch('0|[1-9][0-9]{0,38}',v)is not None)
    n=int(v);need(n<2**bits);return n
def closed(v,keys):need(type(v)is dict and set(v)==set(keys))
def validate_facts(phase,facts):
    need(type(phase)is str and phase in FACTS);closed(facts,FACTS[phase])
    for key,rule in FACTS[phase].items():
        v=facts[key]
        if rule=='h':need(hex64(v))
        elif rule in ('u64','u128'):uint(v,int(rule[1:]))
        elif rule=='b':need(type(v)is bool)
        elif rule=='code':need(type(v)is int and 0<=v<=255)
        elif rule=='state':need(v in ('exited','running','paused','unknown'))
        elif rule=='purpose':need(v in ('backup_snapshot','container_update','integration_update'))
        elif rule=='identity':need(v in ('verified_live','verified_exited','unknown'))
        elif rule=='reason':need(v in REASONS)
        elif rule=='closed_source':need(v in('disabled','expired','revoked'))
        elif rule=='expiry':
            if v!='none':uint(v,64)
        elif rule=='unknown':need(v=='unknown')
        elif rule=='false':need(v is False)
def record_body(operation_id,approval,phase,facts,at_ns,domain,sequence,previous):
    need(type(operation_id)is str and re.fullmatch('[a-f0-9]{32}',operation_id)is not None)
    need(hex64(approval)and hex64(domain));validate_facts(phase,facts);uint(at_ns,64)
    return {'schema_version':1,'operation_id':operation_id,'approval_sha256':approval,'phase':phase,
      'facts':copy.deepcopy(facts),'at_ns':at_ns,'clock_domain_sha256':domain,
      'sequence':str(sequence),'previous_sha256':previous}
def validate_operation(op):
    closed(op,['operation_id','approval_sha256','records']);rows=op['records']
    need(type(rows)is list and 1<=len(rows)<=len(PHASES)+1)
    previous=None
    need(type(rows[0])is dict and type(rows[0].get('body'))is dict)
    first=rows[0].get('body',{}).get('phase')
    phases=FROZEN_PHASES if first=='frozen_begin'else BOOTSTRAP_PHASES if first=='bootstrap_begin'else PHASES
    for i,row in enumerate(rows):
        closed(row,['body','sha256']);b=row['body']
        closed(b,['schema_version','operation_id','approval_sha256','phase','facts','at_ns',
                  'clock_domain_sha256','sequence','previous_sha256'])
        need(type(b['schema_version'])is int and b['schema_version']==1)
        expected=record_body(op['operation_id'],op['approval_sha256'],b['phase'],b['facts'],b['at_ns'],
                             b['clock_domain_sha256'],i+1,previous)
        need(b==expected and row['sha256']==digest(b))
        if b['phase']=='frozen_begin':need(uint(b['facts']['deadline_ns'],64)>uint(b['at_ns'],64))
        if b['phase']=='bootstrap_begin':need(uint(b['facts']['deadline_ns'],64)>uint(b['at_ns'],64))
        if b['phase']=='frozen_complete':need(b['facts']['source_authorization_sha256']==rows[0]['body']['facts']['source_authorization_sha256'])
        if b['phase']in('failed','cancelled','rescued'):
            need(i>0 and i==len(rows)-1)
            if b['phase']=='cancelled':need(i<=2 and b['facts']['no_effects_dispatched']is True)
            if b['phase']=='rescued':need(i>=3 and b['facts']['metadata_disabled']is True)
            if b['phase']!='failed':
                need(b['clock_domain_sha256']==rows[0]['body']['clock_domain_sha256']
                  and uint(b['at_ns'],64)>=uint(rows[i-1]['body']['at_ns'],64))
        else:
            need(i<len(phases)and b['phase']==phases[i])
            need(b['clock_domain_sha256']==rows[0]['body']['clock_domain_sha256'])
            if i:need(uint(b['at_ns'],64)>=uint(rows[i-1]['body']['at_ns'],64))
        if i:need(rows[i-1]['body']['phase']not in ('complete','failed','cancelled','rescued','frozen_complete','bootstrap_report_recorded'))
        previous=row['sha256']
    return op
def validate_snapshot(value):
    closed(value,['body','sha256']);body=value['body']
    need(type(body)is dict and type(body.get('schema_version'))is int and body['schema_version']in(1,2,3))
    closed(body,['schema_version','revision','operations']+(['archived_operations','archive_sha256']if body['schema_version']>=2 else [])+
      (['restored_operations','restored_history_sha256','history_restore_state','restore_snapshot_sha256','restore_authorization_sha256']if body['schema_version']==3 else []))
    uint(body['revision'],64)
    if body['schema_version']>=2:
        count=uint(body['archived_operations'],64)
        need((count==0 and body['archive_sha256']is None)or(count>0 and hex64(body['archive_sha256'])))
    if body['schema_version']==3:
        uint(body['restored_operations'],64)
        need(all(hex64(body[k])for k in('restored_history_sha256','restore_snapshot_sha256','restore_authorization_sha256')))
        need(body['history_restore_state']in('pending','complete'))
        if body['history_restore_state']=='pending':need(body['operations']==[])
    need(type(body['operations'])is list and len(body['operations'])<=MAX_OPERATIONS)
    need(len({op['operation_id']for op in body['operations']})==len(body['operations']))
    for op in body['operations']:validate_operation(op)
    need(hex64(value['sha256'])and digest(body)==value['sha256']);return body
def pairs(items):
    out={}
    for k,v in items:need(k not in out);out[k]=v
    return out

class Journal:
    """Bounded, append-only logical records in an atomic Root-owned snapshot."""
    def __init__(self,directory,approval_sha256,*,uid=0,gid=0,read_only=False):
        self.tx=None;self.approval=approval_sha256;self.read_only=read_only
        try:self.tx=FileTransaction(directory,directory,approval_sha256,uid=uid,gid=gid,read_only=read_only)
        except (OSError,DeploymentUnavailable):raise MaintenanceUnavailable('maintenance_open_failed')from None
    def _read(self):
        try:self.tx._anchors();raw=self.tx._read(self.tx.state_fd,'maintenance.json',0o600)
        except FileNotFoundError:return None
        except (OSError,DeploymentUnavailable):raise MaintenanceUnavailable('maintenance_read_failed')from None
        try:
            value=json.loads(raw,object_pairs_hook=pairs);validate_snapshot(value)
            need(canonical(value)==raw);return value
        except (ValueError,UnicodeError,KeyError,TypeError,RecursionError,MaintenanceUnavailable):
            raise MaintenanceUnavailable('maintenance_snapshot_invalid')from None
    def status(self):
        value=self._read();return copy.deepcopy(value)
    def find(self,operation_id):
        value=self._read()
        if value and value['body']['schema_version']==3:
            need(value['body']['history_restore_state']=='complete','maintenance_restore_pending')
        op=next((v for v in(value['body']['operations']if value else[])if v['operation_id']==operation_id),None)
        if op is not None:return copy.deepcopy(op)
        from restored_history import History
        need(not History(self.tx).consumed(operation_id,value),'maintenance_historical_operation_consumed')
        from maintenance_archive import Archive
        archive=Archive(self.tx);archive.checked(value)
        return archive.find(operation_id)
    def _retire_one(self,old):
        from maintenance_archive import Archive,TERMINAL
        op=next((v for v in old['body']['operations']if v['records'][-1]['body']['phase']in TERMINAL),None)
        need(op is not None,'maintenance_capacity_reached')
        # Preserve and verify the complete operation before reducing the active
        # set. A crash at either boundary cannot free a consumed operation ID.
        archive=Archive(self.tx);archive.checked(old);archive.preserve(op)
        body=copy.deepcopy(old['body']);body['operations'].remove(op)
        index=archive.index()[1]
        body.update(schema_version=max(2,body['schema_version']),archived_operations=str(len(index['body']['operations'])),archive_sha256=index['sha256'])
        body['revision']=str(uint(body['revision'],64)+1)
        value={'body':body,'sha256':digest(body)};validate_snapshot(value)
        try:
            need(self._read()==old,'maintenance_concurrent_change')
            self.tx._anchors();self.tx._atomic(self.tx.state_fd,'maintenance.json',canonical(value),0o600)
        except (OSError,DeploymentUnavailable):raise MaintenanceUnavailable('maintenance_write_uncertain')from None
        return self._read()
    def history_files(self):
        """Yield bounded historical data; exhaust before publishing a backup.

        These bytes include old policy receipts as evidence, never authority.
        No current grant, policy, prepared request, lock or source secret is
        exported. The separately reviewed backup transport owns the destination.
        """
        from maintenance_archive import Archive,MAX_OPERATION_BYTES
        snapshot=self._read();archive=Archive(self.tx);index=archive.checked(snapshot)
        from restored_history import History
        restored=History(self.tx);restored.checked(snapshot)
        active=snapshot['body']['operations']if snapshot else []
        if snapshot is not None:yield 'maintenance.json',canonical(snapshot)
        if index is not None:yield 'maintenance-archive.json',index[0]
        def operations():
            for op in active:yield op,None
            for row in index[1]['body']['operations']if index else []:
                raw,op=archive.load(row)
                yield op,raw
        seen=set()
        for op,raw in operations():
            identity=op['operation_id']
            if raw is not None:yield 'maintenance-archive-'+identity+'.json',raw
            if identity in seen:continue
            seen.add(identity)
            for prefix in ('backup-plan-','backup-rescue-','binding-','source-policy-seal-'):
                name=prefix+identity+'.json'
                try:receipt,value=archive._read(name)
                except FileNotFoundError:continue
                closed(value,['body','sha256']);body=value['body']
                need(type(body)is dict and body.get('operation_id')==identity
                  and body.get('approval_sha256')==op['approval_sha256']and value['sha256']==digest(body)
                  and len(receipt)<=MAX_OPERATION_BYTES,'maintenance_history_receipt_invalid')
                yield name,receipt
        yield from restored.files(snapshot)
        need(self._read()==snapshot and archive.index()==index,'maintenance_history_changed')
    def append(self,operation_id,phase,facts,*,at_ns,clock_domain_sha256,expected_previous_sha256):
        need(not self.read_only,'maintenance_read_only');old=self._read()
        if old and old['body']['schema_version']==3:
            need(old['body']['history_restore_state']=='complete','maintenance_restore_pending')
        body=copy.deepcopy(old['body'])if old else {'schema_version':1,'revision':'0','operations':[]}
        op=next((v for v in body['operations']if v['operation_id']==operation_id),None)
        if op is None:
            need(phase in('begin','frozen_begin','bootstrap_begin')and expected_previous_sha256 is None,'maintenance_parent_changed')
            # Validate new input and the historical ID before storage changes.
            record_body(operation_id,self.approval,phase,facts,at_ns,clock_domain_sha256,1,None)
            need(self.find(operation_id)is None,'maintenance_operation_archived')
            if len(body['operations'])>=MAX_OPERATIONS:
                old=self._retire_one(old);body=copy.deepcopy(old['body'])
            need(len(body['operations'])<MAX_OPERATIONS,'maintenance_capacity_reached')
            op={'operation_id':operation_id,'approval_sha256':self.approval,'records':[]};body['operations'].append(op)
        need(op['approval_sha256']==self.approval,'maintenance_approval_changed')
        rows=op['records'];existing=next((r for r in rows if r['body']['phase']==phase),None)
        if existing:
            b=existing['body'];proposed=record_body(operation_id,self.approval,phase,facts,at_ns,clock_domain_sha256,int(b['sequence']),b['previous_sha256'])
            need(proposed==b,'maintenance_record_conflict')
            return {'state':'duplicate','receipt':copy.deepcopy(existing),'effect_executed':False,'automatic_retry':False}
        parent=rows[-1]['sha256']if rows else None
        need(parent==expected_previous_sha256,'maintenance_parent_changed')
        row={'body':record_body(operation_id,self.approval,phase,facts,at_ns,clock_domain_sha256,len(rows)+1,parent)}
        row['sha256']=digest(row['body']);rows.append(row);validate_operation(op)
        body['revision']=str(uint(body['revision'],64)+1);next_value={'body':body,'sha256':digest(body)}
        validate_snapshot(next_value);raw=canonical(next_value);need(len(raw)<=1048576,'maintenance_capacity_reached')
        try:
            need(self._read()==old,'maintenance_concurrent_change')
            self.tx._anchors();self.tx._atomic(self.tx.state_fd,'maintenance.json',raw,0o600)
        except (OSError,DeploymentUnavailable):raise MaintenanceUnavailable('maintenance_write_uncertain')from None
        return {'state':'recorded','receipt':copy.deepcopy(row),'effect_executed':False,'automatic_retry':False}
    def close(self):
        if self.tx is not None:self.tx.close();self.tx=None

def correlation_facts(op):
    """Protocol/binding comparisons only. These facts are not a continuity pass."""
    validate_operation(op);rows={r['body']['phase']:r for r in op['records']};last=op['records'][-1]
    result={'operation_id':op['operation_id'],'approval_sha256':op['approval_sha256'],
      'phase':last['body']['phase'],'head_sha256':last['sha256'],'records':len(op['records']),
      'effect_executed':False,'automatic_retry':False,'full24h_proven':False}
    if last['body']['phase']!='complete':return result
    b=rows['begin']['body']['facts'];a=rows['armed']['body']['facts'];s=rows['source_stopped']['body']['facts']
    d=rows['source_drained']['body']['facts'];c=rows['consumer_stopped']['body']['facts']
    started=rows['consumer_started']['body']['facts'];r=rows['consumer_ready']['body']['facts']
    n=rows['new_source_verified']['body']['facts'];done=rows['complete']['body']['facts']
    result['comparisons']={
      'armed_exact_window':a['window_id_sha256']==b['window_id_sha256']and uint(a['consumer_checkpoint_sequence'],64)>uint(b['consumer_checkpoint_sequence'],64),
      'old_binding_preserved':b['source_binding_sha256']==rows['source_stop_intent']['body']['facts']['binding_sha256']==s['binding_sha256'],
      'old_source_closed':s['source_epoch']==d['source_epoch']==b['source_epoch']and s['source_instance_sha256']==d['source_instance_sha256']==b['source_instance_sha256']
        and s['container_state']=='exited'and s['exit_code']==0 and s['sender_pidfd_exited']and d['source_closed'],
      'old_tail_ACKed':uint(d['accepted_frames'],128)>=uint(b['accepted_frames'],128)and d['accepted_frames']==d['acknowledged_frames']
        and not d['pending_packet']and not d['active_counts_nonempty']and d['unknown_epoch_tails']==b['unknown_epoch_tails'],
      'consumer_stopped':c['container_state']=='exited'and c['exit_code']==0 and c['binding_sha256']==rows['consumer_stop_intent']['body']['facts']['binding_sha256']==b['consumer_binding_sha256'],
      'consumer_started_binding':started['binding_sha256']==r['binding_sha256']==rows['consumer_start_intent']['body']['facts']['binding_sha256'],
      'consumer_started_boundary':started['start_boundary_ns']==rows['consumer_start_intent']['body']['at_ns'],
      'consumer_observation_fresh':uint(r['reader_observed_ns'],64)>=uint(started['start_boundary_ns'],64)
        and uint(r['reader_observed_ns'],64)<=uint(rows['consumer_ready']['body']['at_ns'],64)
        and r['consumer_instance_sha256']!=b['consumer_instance_sha256']
        and uint(r['consumer_checkpoint_sequence'],64)>uint(c['consumer_checkpoint_sequence'],64)>=uint(d['consumer_checkpoint_sequence'],64),
      'reader_unchanged':b['reader_instance_sha256']==d['reader_instance_sha256']==r['reader_instance_sha256']==n['reader_instance_sha256'],
      'stopped_source_during_readiness':r['source_closed']and r['source_identity']=='verified_exited'
        and r['old_source_epoch']==b['source_epoch']and r['old_source_instance_sha256']==b['source_instance_sha256'],
      'protocol_preserved_during_consumer_stop':r['protocol_counts_sha256']==d['protocol_counts_sha256'],
      'new_binding_preserved':rows['source_start_intent']['body']['facts']['binding_sha256']==rows['source_started']['body']['facts']['binding_sha256']==n['binding_sha256']==done['binding_sha256'],
      'source_started_boundary':rows['source_started']['body']['facts']['start_boundary_ns']==rows['source_start_intent']['body']['at_ns'],
      'source_started_after_ready':uint(n['started_ns'],64)>=uint(rows['source_start_intent']['body']['at_ns'],64)>=uint(rows['consumer_ready']['body']['at_ns'],64)
        and uint(n['started_ns'],64)<=uint(n['covered_before_ns'],64)<=uint(rows['new_source_verified']['body']['at_ns'],64),
      'exact_next_source_epoch':uint(n['source_epoch'],128)==uint(b['source_epoch'],128)+1 and done['source_epoch']==n['source_epoch']
        and n['source_instance_sha256']!=b['source_instance_sha256']and done['source_instance_sha256']==n['source_instance_sha256'],
      'new_source_cut_ACKed':uint(done['acknowledged_frames'],128)>=uint(n['accepted_frames'],128)>=uint(d['accepted_frames'],128)
        and uint(done['consumer_checkpoint_sequence'],64)>uint(r['consumer_checkpoint_sequence'],64),
    }
    return result
