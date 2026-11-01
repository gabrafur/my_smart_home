"""Closed functional proof for one defect; never general residential health.

The before failure comes from the immutable validator's actual isolated run.
The after probe is a distinct at-most-once isolated unit after native apply.
Fresh readonly API identities surround that probe. Neither a loaded hash alone
nor a model-provided passed flag is accepted as a functional execution receipt.
"""
import json, os, time
from pathlib import Path
from source_writer import need, read, raw, sha, write_new
from validation_profile import Validator, bounded

class HostResetFunctional:
 def __init__(self,profile,writer,readonly,admission,state,clock=time.time):
  self.profile,self.writer,self.readonly,self.admission,self.state,self.clock=profile,writer,readonly,admission,Path(state),clock
 def _validated(self,op):
  from preparer import accepted_validation_folder
  return accepted_validation_folder(self.profile,self.state,op)
 def _binding(self,row):
  prep=json.loads(read(self.state/'sealed'/row['id']/'preparation.json',0,0o600))
  return {**prep['binding'],'action':'apply','before_sha256':row['base'],'after_sha256':row['candidate']}
 def _actual(self,binding,candidate):
  p=self.readonly.collect(binding,[candidate])
  need(p['state']=='observed'and p['loaded_sha256']==candidate and p['session_revoked']is True and p['collection_error']is None,'functional_loaded_identity_unconfirmed')
  return p
 def _isolated_after(self,op,folder,check):
  intent=folder/'functional-after-intent.json';receipt=folder/'functional-after-result.json'
  if receipt.exists():return json.loads(read(receipt,0,0o600))
  need(not intent.exists(),'functional_after_outcome_unknown_inspect_no_retry')
  validator=Validator(self.profile,state_root=self.state,clock=self.clock);trusted=validator.trusted()
  validated=self._validated(op)
  previous=json.loads(read(validated/'validator-intent.json',0,0o600))
  properties=previous['properties'].copy()
  # Same already-proved jail/public snapshot; this phase writes no flow artifact.
  properties.pop('BindPaths',None)
  properties.update(ReadWritePaths='/tmp /out',LimitFSIZE='65536',RuntimeMaxSec='30',MemoryMax='134217728')
  unit='raspberry-component-functional-'+op
  command=['/usr/bin/systemd-run','--quiet','--wait','--pipe','--unit='+unit]
  for k,v in properties.items():command.append('--property='+k+'='+v)
  # Keep this short-lived unit observable before executing the unchanged probe.
  # This fixed one-second wait is inside the same resource/sandbox limits.
  launcher="import os,time;time.sleep(1);os.execv('/usr/bin/node',['/usr/bin/node','--jitless','--no-expose-wasm','--max-old-space-size=64','/trusted/functional_probe.mjs'])"
  command+=['/usr/bin/python3','-I','-S','-B','-c',launcher]
  # The validated candidate flows must be mounted readonly for the functional probe.
  generated=validated/'candidate-sources/nodered/flows.json'
  properties['BindReadOnlyPaths']+=' '+str(generated)+':/workspace/nodered/flows.json'
  i=next(i for i,x in enumerate(command)if x.startswith('--property=BindReadOnlyPaths='))
  command[i]='--property=BindReadOnlyPaths='+properties['BindReadOnlyPaths']
  now=self.clock();check();write_new(intent,raw({'operation_id':op,'unit':unit,'properties':properties,'observed_at':now,'automatic_retry':False}))
  result=bounded(command,8192,4096,45,{'PATH':'/usr/bin:/bin','LC_ALL':'C'},unit=unit)
  native=bounded(['/usr/bin/systemctl','show',unit,'--property=LoadState,InvocationID,ActiveState,Result,ExecMainStatus,NoNewPrivileges,PrivateNetwork,PrivateDevices,User,Group,MemoryMax,CapabilityBoundingSet,RestrictAddressFamilies,RootDirectory,BindReadOnlyPaths,BindPaths'],16384,4096,10,{'PATH':'/usr/bin:/bin','LC_ALL':'C'})
  post=dict(line.split('=',1)for line in native['stdout'].decode().splitlines()if'='in line)
  live=result.get('live_properties');need(type(live)is bytes,'functional_live_properties_not_observed');metadata=dict(line.split('=',1)for line in live.decode().splitlines()if'='in line)
  write_new(folder/'functional-after-native.json',raw({'observed_at':self.clock(),'returncode':result['returncode'],'native_returncode':native['returncode'],'unit':metadata,'post_exit_unit':post,'live_observed_at':result.get('live_observed_at'),'exit_source':'same_unique_unit_systemd_run_wait','stdout_sha256':sha(result['stdout']),'stderr_sha256':sha(result['stderr']),'output_limit':result['output_limit'],'deadline_exceeded':result['deadline_exceeded'],'automatic_retry':False}))
  need(result['returncode']==native['returncode']==0 and not result['deadline_exceeded']and not result['output_limit']and not native['deadline_exceeded']and not native['output_limit'],'functional_native_unit_unconfirmed')
  need(all(metadata.get(k)==v for k,v in {'User':'65534','Group':'65534','NoNewPrivileges':'yes','PrivateNetwork':'yes','PrivateDevices':'yes','MemoryMax':'134217728','MemorySwapMax':'0','TasksMax':'64','CPUQuotaPerSecUSec':'500ms','RuntimeMaxUSec':'30s','CapabilityBoundingSet':'','RootDirectory':properties['RootDirectory']}.items())and post.get('ActiveState')in('inactive','failed')and not metadata.get('BindPaths')and(post.get('LoadState')=='not-found'or post.get('InvocationID')==metadata.get('InvocationID'))and 'path=/usr/bin/python3'in metadata.get('ExecStart','')and '/trusted/functional_probe.mjs'in metadata['ExecStart'],'functional_native_properties_unconfirmed')
  need(result['stdout'].count(b'\n')==1,'functional_probe_frame_invalid');proof=json.loads(result['stdout'])
  need(proof.get('schema_version')==1 and proof.get('source')=='isolated_exact_loaded_candidate_reset_probe'and proof.get('passed')is True and proof.get('status_callbacks')==0 and proof.get('external_effects')==proof.get('production_context_writes')==0 and proof.get('native_full_flow_replay')is False and proof.get('coverage')==['host_observer_test_reset_status_isolation'],'functional_probe_not_passed')
  need(type(proof.get('observed_at'))in(int,float)and now<=proof['observed_at']<=self.clock(),'functional_probe_clock_unconfirmed')
  validator.trusted();check();write_new(receipt,raw(proof));return proof
 def __call__(self,row):
  need(row['component']=='observacao_host','functional_component_not_implemented')
  op=row['id'];folder,_,_,_=self.writer.bundle(op);binding=self._binding(row)
  selected=self._validated(op)
  validated=json.loads(read(selected/'validator-result.json',0,0o600));before=validated.get('functional_regression',{}).get('baseline',{})
  need(before.get('source')=='isolated_exact_loaded_candidate_reset_probe'and before.get('passed')is False and before.get('status_callbacks')==1 and before.get('external_effects')==before.get('production_context_writes')==0,'functional_before_failure_not_proved')
  state=self.writer.status(op,'apply');need(state['source_consistency_confirmed']and state['state']=='terminal','functional_canonical_source_unconfirmed')
  self._actual(binding,row['candidate'])
  with self.admission.locked(binding)as check:after=self._isolated_after(op,folder,check)
  current=self._actual(binding,row['candidate']);state=self.writer.status(op,'apply');need(state['source_consistency_confirmed']and state['state']=='terminal','functional_canonical_source_changed')
  need(before['observed_at']<after['observed_at']and validated['after_sha256']==current['loaded_sha256']==row['candidate'],'functional_source_or_time_mismatch')
  candidate=json.loads(read(folder/'after.json',0,0o600));function=next(n['func']for n in candidate if n['id']=='host_obs_test_build')
  need(after['function_sha256']==sha(function.encode()),'functional_actual_function_mismatch')
  return {'operation_id':op,'component_id':row['component'],'task_id':row['task'],'collection_error':None,'loaded_sha256':current['loaded_sha256'],'same_operation_before_failed':True,'same_operation_after_passed':True,'regressions_checked':all(validated.get('checks',{}).get(k)=='passed'for k in ('source_consistency','pure_function_regression','dry_run_regression','unchanged_scope')),'no_household_test_effects':True,'observed_at':self.clock(),'before_failed_at':before['observed_at'],'after_success_at':after['observed_at'],'coverage':['host_observer_test_reset_status_isolation','fresh_native_scoped_loaded_identity'],'native_full_flow_replay':False,'physical_health':'unknown','source':'protected_isolated_functional_units_and_readonly_native_identity'}
