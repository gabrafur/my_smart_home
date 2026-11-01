"""Read-only reciprocal gate. Caller must hold the existing operations lock.
Native brokers derive effect kinds from fixed dispatch; chatbot fields never do.
The same operations lock is held by a component worker through its effect.
"""
import hashlib,json,os,sqlite3,stat,time
from pathlib import Path
from component_jobs import COMPONENTS,ident,need,protected
IN_FLIGHT=frozenset(('apply_intent','uncertain','rollback_intent','rollback_uncertain'))
KNOWN=frozenset(('prepared','validated','applied_awaiting_functional_proof','verified','failed_without_effect','confirmed_not_applied','rolled_back','rollback_rejected_without_effect','released'))|IN_FLIGHT
# Internal effect kinds, selected in reviewed native dispatch, never MCP arguments.
SCOPES={'scoped_codex_task':COMPONENTS,'legacy_codex_send':COMPONENTS,'legacy_notice_migration':COMPONENTS,'native_icloud_deployment':frozenset(('icloud_adapter',)),'NodeRED_reader_binding':frozenset(('localizacao_pessoas','observacao_host')),'generic_project_source_mutation':COMPONENTS}
class ReciprocalGuard:
 def __init__(self,journal,operations_lock,owner=0,clock=time.time):self.path=Path(journal);self.lock=operations_lock;self.owner=owner;self.clock=clock
 def check(self,kind,own_operation=None):
  need(kind in SCOPES,'unknown_native_mutation_scope');need(self.lock.check()is True,'reciprocal_operations_lock_not_held')
  if own_operation is not None:ident(own_operation)
  from component_jobs import JobLedger
  jobs=JobLedger(self.path.with_name('jobs.sqlite3'),owner=self.owner,read_only=True)
  try:need(all(row['operation']==own_operation for row in jobs.pending_jobs()),'component_job_launch_or_effect_unknown')
  finally:jobs.close()
  identity=protected(self.path,self.owner,0o600)
  db=sqlite3.connect(self.path.as_uri()+'?mode=ro',uri=True,timeout=2,isolation_level=None);db.row_factory=sqlite3.Row
  try:
   db.execute('PRAGMA query_only=ON');db.execute('BEGIN');rows=db.execute('SELECT id,component,state,result FROM operations LIMIT 65').fetchall();need(len(rows)<=64,'component_reservation_capacity_invalid')
   for row in rows:
    need(row['component']in COMPONENTS and row['state']in KNOWN,'component_reservation_state_unknown')
    if own_operation is not None and row['id']==own_operation:continue
    result=json.loads(row['result'])if row['result']else{}
    need(type(result)is dict,'component_result_invalid')
    need(row['state']not in IN_FLIGHT,'component_effect_in_flight_or_uncertain')
    need(result.get('security_cleanup_confirmed')is not False and not result.get('pending_cleanup_actions'),'component_security_cleanup_pending')
    need(row['state']=='released'or row['component']not in SCOPES[kind],'component_scope_reserved')
   need(protected(self.path,self.owner,0o600)==identity,'component_reservation_identity_changed');self.lock.check()
   return {'source':'protected_component_reservation_ledger_under_operations_lock','observed_at':self.clock(),'age_seconds':0,'collection_error':None,'admission_allowed':True,'reserved_components_checked':len(rows),'coverage':['registered_component_reservations','not_arbitrary_Root_activity_or_functional_health']}
  finally:db.close()

class ForeignHeldOperations:
 """Validate the requesting native broker holds the fixed flock already.
 This is an internal Root socket peer PID, never an RPC argument. Checking a
 verdict without this lock would race with a component worker and is refused.
 """
 def __init__(self,peer_pid,path='/run/raspberry-component-guard-inputs/operations.lock'):
  need(type(peer_pid)is int and peer_pid>0,'native_peer_pid_required');self.pid=peer_pid;self.path=Path(path)
 def __enter__(self):self.check();return self
 def __exit__(self,*args):return False
 def check(self):
  s=self.path.lstat();need(stat.S_ISREG(s.st_mode)and s.st_uid==1001 and stat.S_IMODE(s.st_mode)==0o600 and s.st_nlink==1,'native_operations_lock_identity')
  lockid=(os.major(s.st_dev),os.minor(s.st_dev),s.st_ino);fd=os.open('/proc/locks',os.O_RDONLY|os.O_NOFOLLOW)
  try:
   raw=os.read(fd,1048577);need(len(raw)<=1048576,'native_lock_inventory_limit')
  finally:os.close(fd)
  found=False
  for line in raw.decode('ascii').splitlines():
   parts=line.split()
   if len(parts)<8 or parts[1]!='FLOCK'or parts[3]!='WRITE'or parts[4]!=str(self.pid):continue
   fields=parts[5].split(':')
   if len(fields)==3 and (int(fields[0],16),int(fields[1],16),int(fields[2]))==lockid:found=True
  need(found,'native_peer_does_not_hold_operations_lock');return True
