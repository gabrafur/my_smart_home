"""Protected preparer: real isolated validation, explicit Root review and publication input."""
import base64,hashlib,json,math,os,re,stat,time
from pathlib import Path
from source_writer import SourceWriter,need,read,raw,sha,source_set,write_new,protected_dir
from validation_profile import Validator
from preparation_storage import PreparationStorage
STATE=Path('/var/lib/raspberry-component-repair')
CHECKS=('source_consistency','pure_function_regression','dry_run_regression','layout','left_margin','render_review','manual_tests','observability','unchanged_scope','rollback')
def ident(v,n=32):need(type(v)is str and re.fullmatch('[a-f0-9]{'+str(n)+'}',v),'identity_refused');return v
def normalize_numbers(v):
 if isinstance(v,float):need(math.isfinite(v),'nonfinite_json');return int(v)if v.is_integer()else v
 if type(v)is list:return[normalize_numbers(x)for x in v]
 if type(v)is dict:return{k:normalize_numbers(x)for k,x in v.items()}
 return v
def normalized(nodes):
 rows=[]
 for n in nodes:
  d=json.loads(json.dumps(n));d.setdefault('wires',[]);need(type(d['wires'])is list and all(type(x)is list for x in d['wires']),'wire_shape_refused')
  while d['wires']and not d['wires'][-1]:d['wires'].pop()
  rows.append(d)
 rows.sort(key=lambda n:n['id']);return sha(raw(normalize_numbers(rows)))
def scope(rows):return[n for n in rows if n['id']=='host_observer_tab'or n.get('z')=='host_observer_tab']
def candidate_delta(before,after):
 need(type(after)is list and 0<len(after)<=2048,'candidate_scope_bound');a={n['id']:n for n in before};b={n['id']:n for n in after};need(len(a)==len(before)and len(b)==len(after)and a.keys()==b.keys(),'candidate_inventory_changed');count=0
 for k,v in a.items():
  changed={key for key in set(v)|set(b[k])if v.get(key)!=b[k].get(key)}
  if not changed:continue
  need(changed=={'func'}and v['type']=='function'or changed=={'rules'}and v['type']=='change','candidate_effect_boundary_changed');count+=1
 need(0<count<=16,'candidate_change_bound')
def accepted_validation_folder(profile,state,op):
 """Resolve one Root-owned proof selection without replacing the old failure."""
 folder=protected_dir(Path(state)/'sealed'/ident(op));selector=folder/'validation-selection.json'
 if not selector.exists():
  compatibility=profile.get('validation_compatibility')
  need(not(type(compatibility)is dict and compatibility.get('operation_id')==op),'root_selected_validation_required')
  return folder
 selection=json.loads(read(selector,0,0o600));compat=profile.get('validation_compatibility')
 fields={'kind','operation_id','attempt_id','profile_sha256','previous_phase_sha256','proof_sha256','native_receipt_sha256','intent_sha256','phase_sha256','selected_at'}
 need(type(selection)is dict and set(selection)==fields and selection['kind']=='root_selected_actual_validation'and selection['operation_id']==op,'validation_selection_shape')
 need(type(compat)is dict and compat['operation_id']==op and selection['profile_sha256']==sha(raw(profile))and selection['previous_phase_sha256']==compat['previous_validation_phase_sha256']==sha(read(folder/'validation-phase-result.json',0,0o600)),'validation_selection_profile_or_history_changed')
 attempt=protected_dir(protected_dir(folder/'validation-attempts')/ident(selection['attempt_id']))
 for field,name in [('proof_sha256','validator-result.json'),('native_receipt_sha256','validator-native-receipt.json'),('intent_sha256','validator-intent.json'),('phase_sha256','validation-phase-result.json')]:
  ident(selection[field],64);need(sha(read(attempt/name,0,0o600))==selection[field],'validation_selection_artifact_changed')
 phase=json.loads(read(attempt/'validation-phase-result.json',0,0o600));intent=json.loads(read(attempt/'validator-intent.json',0,0o600));native=json.loads(read(attempt/'validator-native-receipt.json',0,0o600))
 need(phase['operation_id']==op and phase['state']=='validation_passed_awaiting_root_review'and phase['validation_profile_sha256']==selection['profile_sha256']and phase['protected_receipt_sha256']==selection['proof_sha256']and intent['profile_sha256']==selection['profile_sha256']and native['unit_terminal']is True and native['returncode']==0,'validation_selection_not_actual_success')
 return attempt
def public_directory(root,relative):
 """Only create new public dirs; never chmod the existing private operation."""
 current=Path(root)
 if not current.exists():current.mkdir(mode=0o755);current.chmod(0o755)
 need(current.is_dir()and not current.is_symlink()and current.stat().st_uid==0 and stat.S_IMODE(current.stat().st_mode)==0o755,'new_public_directory_metadata')
 for part in Path(relative).parts:
  need(part not in('.','..','/')and '/'not in part,'public_directory_component_refused');current=current/part
  if not current.exists():current.mkdir(mode=0o755);current.chmod(0o755)
  need(current.is_dir()and not current.is_symlink()and current.stat().st_uid==0 and stat.S_IMODE(current.stat().st_mode)==0o755,'new_public_directory_metadata')
 return current
class ComponentPreparer:
 def __init__(self,profile,baseline,jobs,root_policy,state_root=STATE,repository=Path('/mnt/data/docker'),clock=time.time):
  self.profile=profile;self.baseline=baseline;self.jobs=jobs;self.policy=root_policy;self.state=Path(state_root);self.repo=Path(repository);self.clock=clock;self.writer=SourceWriter(profile,state_root,repository,clock);self.profile_sha=sha(raw(profile))
 def active(self):
  need(os.geteuid()==0 and self.clock()<min(self.policy['expires_at'],self.profile['owner_authorization_expires_at']),'active_root_authority_required')
  need(not(self.state/'revoked').exists(),'component_preparer_revoked');need(self.profile['approval_reference_sha256']==self.policy['approval_reference_sha256'],'standing_goal_approval_changed')
 def prepare(self,binding,send_id,expires_at,expected_loaded_sha256,proposal_id):
  self.active();ident(binding.get('operation_id'))
  with PreparationStorage(self.state).reserve(binding['operation_id']):return self._prepare_reserved(binding,send_id,expires_at,expected_loaded_sha256,proposal_id)
 def _prepare_reserved(self,binding,send_id,expires_at,expected_loaded_sha256,proposal_id):
  self.active();need(self.baseline is not None,'protected_baseline_port_required');need(set(binding)=={'operation_id','task_id','principal_sha256','component_id','action'}and binding['component_id']=='observacao_host'and binding['action']=='observe','preparation_binding_refused')
  op=ident(binding['operation_id']);ident(binding['task_id']);ident(send_id);ident(binding['principal_sha256'],64);ident(expected_loaded_sha256,64);ident(proposal_id)
  need(binding['principal_sha256']==self.policy['principal_sha256']and self.clock()<expires_at<=min(self.clock()+86400,self.policy['expires_at'],self.profile['owner_authorization_expires_at']),'preparation_identity_or_window')
  sealed=protected_dir(self.state/'sealed');need(sum(1 for p in sealed.iterdir()if p.is_dir())<self.profile['max_preparation_slots'],'preparation_storage_slots_full');folder=sealed/op;need(not folder.exists(),'existing_preparation_inspect_only');folder.mkdir(mode=0o700)
  prep={'binding':binding,'send_id':send_id,'expires_at':expires_at,'expected_loaded_sha256':expected_loaded_sha256};write_new(folder/'preparation.json',raw(prep))
  proof=self.baseline.collect(binding,[expected_loaded_sha256]);need(proof.get('state')=='observed'and proof.get('loaded_sha256')==expected_loaded_sha256 and proof.get('session_revoked')is True and proof.get('collection_error')is None and 0<=self.clock()-proof['observed_at']<=60,'loaded_baseline_not_proved')
  return self._finish_reserved(binding,expires_at,expected_loaded_sha256,proposal_id,folder,prep)
 def _finish_reserved(self,binding,expires_at,expected_loaded_sha256,proposal_id,folder,prep):
  self.active();op=ident(binding['operation_id'])
  proposal=json.loads(read(self.state/'proposals'/(proposal_id+'.json'),0,0o600));need(set(proposal)=={'component_id','sources','candidate_nodes'}and proposal['component_id']=='observacao_host','closed_proposal_shape')
  need(set(proposal['sources'])==set(self.writer.paths)and all(type(v)is str and len(v.encode())<=131072 for v in proposal['sources'].values()),'closed_source_proposal_refused')
  before=self.writer.current();need(all(sha(v)==self.profile['snapshot_hashes'][k]for k,v in before.items()),'canonical_before_not_profile_revision');after={p:proposal['sources'][p].encode()for p in self.writer.paths}
  need(source_set(before)!=source_set(after),'empty_source_proposal')
  metadata={};snapshot=folder/'public-snapshot';overlay=folder/'candidate-sources';need(not snapshot.exists()and not overlay.exists(),'snapshot_already_present');public_directory(snapshot,Path());public_directory(overlay,Path());total=0
  for name,expected in self.profile['snapshot_hashes'].items():
   need(name=='nodered/flows.json'or name.startswith('nodered/tools/')or name in ('nodered/package.json','scripts/host-observation/observer.py'),'public_snapshot_path_refused')
   data=read(Path('/usr/local/lib/raspberry-component-repair/profiles/observacao_host/runtime/public-flow.json'),0,0o444,limit=8*1024*1024)if name=='nodered/flows.json'else read(Path('/usr/local/lib/raspberry-component-repair/profiles/observacao_host/runtime/public-snapshot')/name,0,0o444,limit=8*1024*1024);need(sha(data)==expected,'public_snapshot_source_changed');total+=len(data);need(total<=self.profile['maximum_snapshot_bytes'],'public_snapshot_total_bound')
   target=snapshot/name;public_directory(snapshot,Path(name).parent);write_new(target,data,limit=8*1024*1024);target.chmod(0o444)
  original=json.loads(read(snapshot/'nodered/flows.json',0,0o444,limit=8*1024*1024));before_nodes=scope(original);after_nodes=proposal['candidate_nodes'];candidate_delta(before_nodes,after_nodes)
  need(len(raw(before_nodes))<=1048576 and len(raw(after_nodes))<=1048576,'scoped_nodes_file_bound')
  need(normalized(before_nodes)==expected_loaded_sha256,'canonical_source_not_matching_loaded_baseline')
  for name in [*self.writer.paths,'nodered/flows.json']:
   data=after[name]if name in after else raw(original);target=overlay/name;public_directory(overlay,Path(name).parent);write_new(target,data,limit=8*1024*1024)
   if name=='nodered/flows.json':os.chown(target,65534,65534)
   else:target.chmod(0o444)
   if name in self.writer.paths:
    st=(self.repo/name).lstat();metadata[name]={'uid':st.st_uid,'gid':st.st_gid,'mode':stat.S_IMODE(st.st_mode)};need(metadata[name]==self.profile['sources_owners'][name],'canonical_owner_changed')
  bundle={'operation_id':op,'component_id':'observacao_host','profile_sha256':self.profile_sha,'before':{p:base64.b64encode(v).decode()for p,v in before.items()},'after':{p:base64.b64encode(v).decode()for p,v in after.items()},'before_source_sha256':source_set(before),'after_source_sha256':source_set(after),'metadata':metadata}
  write_new(folder/'sources.json',raw(bundle));write_new(folder/'before.json',raw(before_nodes));write_new(folder/'after.json',raw(after_nodes))
  result={'state':'preparation_ready_for_validation','operation_id':op,'task_id':binding['task_id'],'component_id':'observacao_host','before_sha256':normalized(before_nodes),'after_sha256':normalized(after_nodes),'preparation_sha256':sha(raw(prep)),'source_set_sha256':source_set(after),'expires_at':expires_at,'automatic_retry':False,'functional_health':'unknown'};write_new(folder/'preparation-result.json',raw(result));return result
 def continue_preparation(self,binding,send_id,expires_at,expected_loaded_sha256,proposal_id):
  """Finish only the unperformed snapshot tail after exact Root reconciliation.
  This never calls prepare/workflow.prepare and never replaces original facts.
  The baseline is a NEW admitted read, not a reused diagnostic receipt.
  """
  self.active();op=ident(binding.get('operation_id'));ident(binding.get('task_id'));ident(binding.get('principal_sha256'),64);ident(proposal_id);ident(send_id);ident(expected_loaded_sha256,64)
  need(set(binding)=={'operation_id','task_id','principal_sha256','component_id','action'}and binding['component_id']=='observacao_host'and binding['action']=='observe'and binding['principal_sha256']==self.policy['principal_sha256'],'continuation_binding_refused')
  folder=protected_dir(self.state/'sealed'/op);original=read(folder/'preparation.json',0,0o600);prep=json.loads(original)
  need(prep=={'binding':binding,'send_id':send_id,'expires_at':expires_at,'expected_loaded_sha256':expected_loaded_sha256},'continuation_original_preparation_changed')
  review=json.loads(read(folder/'preparation-continuation-review.json',0,0o600))
  fields={'kind','operation_id','preparation_sha256','proposal_sha256','previous_phase_sha256','observation_evidence_sha256','session_store_evidence_sha256','no_effect_before_snapshot_confirmed','read_session_cleanup_confirmed','approved_at','expires_at'}
  need(type(review)is dict and set(review)==fields and review['kind']=='root_exact_preparation_tail_reconciliation'and review['operation_id']==op and review['preparation_sha256']==sha(original),'continuation_root_review_required')
  for key in ('preparation_sha256','proposal_sha256','previous_phase_sha256','observation_evidence_sha256','session_store_evidence_sha256'):ident(review[key],64)
  need(review['no_effect_before_snapshot_confirmed']is True and review['read_session_cleanup_confirmed']is True and 0<=review['approved_at']<=self.clock()<review['expires_at']<=expires_at<=min(self.policy['expires_at'],self.profile['owner_authorization_expires_at']),'continuation_review_or_window_refused')
  need(sha(read(self.state/'proposals'/(proposal_id+'.json'),0,0o600))==review['proposal_sha256'],'continuation_proposal_changed')
  allowed={'preparation.json','preparation-continuation-review.json'}
  need(set(p.name for p in folder.iterdir())==allowed,'existing_continuation_or_tail_inspect_only')
  with PreparationStorage(self.state).continue_reserved(op):
   self.active();write_new(folder/'preparation-continuation-intent.json',raw({'operation_id':op,'review_sha256':sha(raw(review)),'original_preparation_sha256':sha(original),'automatic_retry':False}))
   proof=self.baseline.collect(binding,[expected_loaded_sha256])
   need(proof.get('state')=='observed'and proof.get('loaded_sha256')==expected_loaded_sha256 and proof.get('session_revoked')is True and proof.get('collection_error')is None and 0<=self.clock()-proof['observed_at']<=60,'continuation_fresh_loaded_baseline_not_proved')
   result=self._finish_reserved(binding,expires_at,expected_loaded_sha256,proposal_id,folder,prep)
   write_new(folder/'preparation-continuation-result.json',raw({'operation_id':op,'result':result,'review_sha256':sha(raw(review)),'fresh_baseline_nonce':proof['nonce'],'old_prepare_replayed':False,'automatic_retry':False}));return result
 def validate(self,op):
  self.active();folder=self.writer.location(ident(op));prepared=json.loads(read(folder/'preparation-result.json',0,0o600));need(self.clock()<prepared['expires_at'],'preparation_expired')
  selected=accepted_validation_folder(self.profile,self.state,op)
  if selected!=folder:return json.loads(read(selected/'validation-phase-result.json',0,0o600))
  resultfile=folder/'validation-phase-result.json'
  if resultfile.exists():return json.loads(read(resultfile,0,0o600))
  if(folder/'validator-intent.json').exists():return {'state':'validation_uncertain','operation_id':op,'protected_receipt_sha256':sha(read(folder/'validator-intent.json',0,0o600)),'validation_profile_sha256':self.profile_sha,'source_set_sha256':prepared['source_set_sha256'],'automatic_retry':False,'functional_health':'unknown'}
  try:
   proof=Validator(self.profile,self.repo,self.state,self.clock).run(op,folder)
   need(proof['before_sha256']==prepared['before_sha256']and proof['after_sha256']==prepared['after_sha256'],'actual_generation_not_matching_proposal')
   need(all(proof['checks'].get(k)=='passed'for k in CHECKS if k!='render_review'),'actual_validation_incomplete');state='validation_passed_awaiting_root_review'
  except Exception:
   native=folder/'validator-native-receipt.json';state='validation_failed'if native.exists()and json.loads(read(native,0,0o600)).get('unit_terminal')is True else'validation_uncertain'
  receipt=folder/'validator-result.json'if(folder/'validator-result.json').exists()else folder/'validator-native-receipt.json'if(folder/'validator-native-receipt.json').exists()else folder/'preparation-result.json'
  result={'state':state,'operation_id':op,'protected_receipt_sha256':sha(read(receipt,0,0o600)),'validation_profile_sha256':self.profile_sha,'source_set_sha256':prepared['source_set_sha256'],'automatic_retry':False,'functional_health':'unknown'};write_new(resultfile,raw(result));return result
 def validate_reconciled_once(self,op,attempt_id):
  """One new native validation; old pre-exec failure/receipts remain unchanged."""
  self.active();ident(op);ident(attempt_id);folder=self.writer.location(op);compat=self.profile.get('validation_compatibility')
  need(type(compat)is dict and compat['operation_id']==op,'specific_validation_reconciliation_required')
  previous=read(folder/'validation-phase-result.json',0,0o600);old=json.loads(previous)
  need(sha(previous)==compat['previous_validation_phase_sha256']and old['state']=='validation_failed','previous_validation_changed')
  native_raw=read(folder/'validator-native-receipt.json',0,0o600);native=json.loads(native_raw)
  need(old['protected_receipt_sha256']==sha(native_raw)and native['unit_terminal']is True and native['returncode']==200 and native['stdout_sha256']==sha(b'')and native['stderr_sha256']==sha(b''),'previous_attempt_not_preexec_terminal')
  prepared=json.loads(read(folder/'preparation-result.json',0,0o600));need(self.clock()<prepared['expires_at'],'preparation_expired')
  _,bundle,before,after=self.writer.bundle(op);need(self.writer.current()==before,'current_source_changed')
  attempts=folder/'validation-attempts';need(not attempts.exists()and not(folder/'validation-selection.json').exists(),'existing_reconciled_validation_inspect_no_retry')
  with PreparationStorage(self.state).continue_reserved(op):
   self.active();attempts.mkdir(mode=0o700);trial=attempts/attempt_id;trial.mkdir(mode=0o700)
   write_new(trial/'continuation-intent.json',raw({'operation_id':op,'attempt_id':attempt_id,'profile_sha256':self.profile_sha,'previous_phase_sha256':sha(previous),'automatic_retry':False}))
   snapshot=trial/'public-snapshot';overlay=trial/'candidate-sources';public_directory(snapshot,Path());public_directory(overlay,Path());total=0
   for name,expected in self.profile['snapshot_hashes'].items():
    need(name=='nodered/flows.json'or name.startswith('nodered/tools/')or name in('nodered/package.json','scripts/host-observation/observer.py'),'public_snapshot_path_refused')
    source=Path('/usr/local/lib/raspberry-component-repair/profiles/observacao_host/runtime/public-flow.json')if name=='nodered/flows.json'else Path('/usr/local/lib/raspberry-component-repair/profiles/observacao_host/runtime/public-snapshot')/name
    data=read(source,0,0o444,limit=8*1024*1024);need(sha(data)==expected,'public_snapshot_source_changed');total+=len(data);need(total<=self.profile['maximum_snapshot_bytes'],'public_snapshot_total_bound')
    target=snapshot/name;public_directory(snapshot,Path(name).parent);write_new(target,data,limit=8*1024*1024);target.chmod(0o444)
   flow=read(folder/'candidate-sources/nodered/flows.json',limit=8*1024*1024);need(sha(flow)==compat['candidate_flow_before_sha256'],'old_candidate_flow_changed')
   for name in [*self.writer.paths,'nodered/flows.json']:
    data=flow if name=='nodered/flows.json'else after[name];target=overlay/name;public_directory(overlay,Path(name).parent);write_new(target,data,limit=8*1024*1024)
    if name=='nodered/flows.json':os.chown(target,65534,65534)
    else:target.chmod(0o444)
   state='validation_uncertain'
   try:
    proof=Validator(self.profile,self.repo,self.state,self.clock).run(op,trial,attempt_id)
    need(proof['before_sha256']==prepared['before_sha256']and proof['after_sha256']==prepared['after_sha256']and all(proof['checks'].get(k)=='passed'for k in CHECKS if k!='render_review'),'actual_reconciled_validation_incomplete');state='validation_passed_awaiting_root_review'
   except Exception:
    receipt=trial/'validator-native-receipt.json'
    if receipt.exists()and json.loads(read(receipt,0,0o600)).get('unit_terminal')is True:state='validation_failed'
   receipt=trial/'validator-result.json'if(trial/'validator-result.json').exists()else trial/'validator-native-receipt.json'if(trial/'validator-native-receipt.json').exists()else trial/'continuation-intent.json'
   phase={'state':state,'operation_id':op,'protected_receipt_sha256':sha(read(receipt,0,0o600)),'validation_profile_sha256':self.profile_sha,'source_set_sha256':source_set(after),'automatic_retry':False,'functional_health':'unknown'};write_new(trial/'validation-phase-result.json',raw(phase))
   if state!='validation_passed_awaiting_root_review':return phase
   self.active();need(self.writer.current()==before and self.clock()<prepared['expires_at'],'source_or_window_changed_after_validation')
   selection={'kind':'root_selected_actual_validation','operation_id':op,'attempt_id':attempt_id,'profile_sha256':self.profile_sha,'previous_phase_sha256':sha(previous),'proof_sha256':sha(read(trial/'validator-result.json',0,0o600)),'native_receipt_sha256':sha(read(trial/'validator-native-receipt.json',0,0o600)),'intent_sha256':sha(read(trial/'validator-intent.json',0,0o600)),'phase_sha256':sha(read(trial/'validation-phase-result.json',0,0o600)),'selected_at':self.clock()};write_new(folder/'validation-selection.json',raw(selection));need(accepted_validation_folder(self.profile,self.state,op)==trial,'selected_validation_not_bound');return phase
 def seal(self,op,root_decision_id):
  self.active();need(self.baseline is not None and self.jobs is not None,'protected_review_ports_required');folder=self.writer.location(ident(op));ident(root_decision_id)
  need(not(folder/'review.json').exists(),'existing_review_inspect_only');validated=accepted_validation_folder(self.profile,self.state,op);phase=json.loads(read(validated/'validation-phase-result.json',0,0o600));need(phase['state']=='validation_passed_awaiting_root_review','actual_validation_not_passed')
  proof=json.loads(read(validated/'validator-result.json',0,0o600));decision=json.loads(read(self.state/'operator-decisions'/(root_decision_id+'.json'),0,0o600));prepared=json.loads(read(folder/'preparation.json',0,0o600));_,bundle,before,after=self.writer.bundle(op)
  need(set(decision)=={'kind','operation_id','source_set_sha256','validation_profile_sha256','render_sha256','render_png_sha256','approval_reference_sha256','approved_at','expires_at','disposition'}and decision['kind']=='root_component_source_and_visual_review'and decision['operation_id']==op and decision['disposition']=='approve','root_operator_decision_required')
  need(decision['source_set_sha256']==source_set(after)and decision['validation_profile_sha256']==self.profile_sha and decision['approval_reference_sha256']==self.profile['approval_reference_sha256']and decision['render_sha256']==sha(read(validated/'render.svg',0,0o600))==proof['render_sha256']and decision['render_png_sha256']==sha(read(validated/'render.png',0,0o600))==proof['render_png_sha256'],'root_review_not_bound_to_actual_artifacts')
  need(phase['protected_receipt_sha256']==sha(read(validated/'validator-result.json',0,0o600))and 0<=decision['approved_at']<=self.clock()<decision['expires_at']<=prepared['expires_at'],'root_review_expired_or_changed')
  need(self.writer.current()==before,'source_changed_before_seal');baseline=self.baseline.collect(prepared['binding'],[prepared['expected_loaded_sha256']]);need(baseline.get('state')=='observed'and baseline.get('session_revoked')is True and baseline.get('loaded_sha256')==prepared['expected_loaded_sha256']and 0<=self.clock()-baseline['observed_at']<=60,'current_loaded_baseline_not_proved')
  checks={k:proof['checks'][k]for k in CHECKS if k!='render_review'};checks['render_review']='passed';now=self.clock();validation={'schema_version':1,'source_set_sha256':source_set(after),'validation_profile_sha256':self.profile_sha,'before_sha256':proof['before_sha256'],'after_sha256':proof['after_sha256'],'observed_at':now,'checks':checks};write_new(folder/'validation.json',raw(validation))
  review={'schema_version':1,'operation_id':op,'task_id':prepared['binding']['task_id'],'principal_sha256':prepared['binding']['principal_sha256'],'component_id':'observacao_host','send_id':prepared['send_id'],'before_sha256':proof['before_sha256'],'after_sha256':proof['after_sha256'],'before_file_sha256':sha(read(folder/'before.json',0,0o600)),'after_file_sha256':sha(read(folder/'after.json',0,0o600)),'source_set_sha256':source_set(after),'validation_profile_sha256':self.profile_sha,'validation_sha256':sha(raw(validation)),'approved_at':now,'expires_at':min(prepared['expires_at'],decision['expires_at'],now+86400)};write_new(folder/'review.json',raw(review));self.jobs.register_review(review,sha(raw(review)));return {'state':'sealed_review_registered_publication_pending','operation_id':op,'review_sha256':sha(raw(review)),'automatic_retry':False,'functional_health':'unknown'}
