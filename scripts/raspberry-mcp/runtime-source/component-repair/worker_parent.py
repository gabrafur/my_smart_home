"""Candidate internal parent: pinned worker, private socketpair, protected receipts.
No installed entrypoint, daemon, sudo rule or MCP registration. Production
bootstrap must pin root-owned sources, fixed paths and authenticated principal.
The request surface of run() is operation ID and apply/rollback only. Operator
bindings and dependencies below are never MCP parameters.
"""
import contextlib,ctypes,fcntl,hashlib,json,math,os,resource,selectors,signal,socket,stat,subprocess,time
from pathlib import Path
from admission import need,ident,safe_file,ProtectedAdmission

_prctl=ctypes.CDLL(None,use_errno=True).prctl
DIAGNOSTIC_CODES=frozenset(('active_root_authority_required', 'actual_generated_flow_changed', 'actual_generation_not_matching_proposal', 'actual_reconciled_validation_incomplete', 'actual_validation_incomplete', 'actual_validation_not_passed', 'admin_delegation_unconfirmed', 'administrative_lease_completion_margin', 'administrative_lease_expired', 'admission_frame_binding_refused', 'admission_frame_limit', 'audit_capacity', 'authenticated_native_owner_principal_changed', 'binding_executor_busy_or_uncertain', 'binding_executor_ledger_unconfirmed', 'bootstrap_binary_changed', 'bootstrap_binary_grew', 'bootstrap_source_changed_during_read', 'candidate_change_bound', 'candidate_effect_boundary_changed', 'candidate_inventory_changed', 'candidate_scope_bound', 'candidate_sources_after_changed', 'candidate_sources_before_changed', 'canonical_before_not_profile_revision', 'canonical_owner_changed', 'canonical_source_after_unconfirmed', 'canonical_source_baseline_changed', 'canonical_source_hook_already_bound', 'canonical_source_not_matching_loaded_baseline', 'canonical_validation_mutex_identity', 'clock_unconfirmed', 'closed_component_metadata_request', 'closed_component_request_required', 'closed_job_binding_required', 'closed_native_mutation_guard_request', 'closed_preparation_request', 'closed_proposal_shape', 'closed_root_bootstrap_policy_changed', 'closed_source_proposal_refused', 'closed_task_phase', 'closed_task_phase_state', 'closed_task_purpose', 'closed_task_request_shape', 'component_access_revoked', 'component_action_refused', 'component_action_unconfirmed', 'component_broker_peer_refused', 'component_effect_in_flight_or_uncertain', 'component_effect_port_not_activated', 'component_guard_frame_limit', 'component_guard_peer_refused', 'component_job_action_refused', 'component_job_audit_capacity', 'component_job_capacity', 'component_job_capacity_invalid', 'component_job_id_conflict', 'component_job_launch_or_effect_unknown', 'component_job_not_found', 'component_job_receipt_limit', 'component_job_state_invalid', 'component_job_transition_refused', 'component_ledger_replaced', 'component_not_allowed', 'component_operator_access_revoked', 'component_preparer_revoked', 'component_reply_limit', 'component_request_limit', 'component_request_shape', 'component_reservation_capacity_invalid', 'component_reservation_identity_changed', 'component_reservation_state_unknown', 'component_reserved', 'component_result_invalid', 'component_scope_reserved', 'component_security_cleanup_pending', 'component_state_exists_or_unconfirmed', 'component_state_initialization_expired', 'component_version_binding_changed', 'component_workflow_not_ready', 'continuation_binding_refused', 'continuation_fresh_loaded_baseline_not_proved', 'continuation_original_preparation_changed', 'continuation_proposal_changed', 'continuation_review_or_window_refused', 'continuation_root_review_required', 'contract_profile_pin_changed', 'contract_registry_state_invalid', 'current_loaded_baseline_not_proved', 'current_source_changed', 'deployment_contract_unconfirmed', 'deployment_effect_busy_or_uncertain', 'destination_not_proven', 'durable_effect_busy_or_uncertain', 'durable_effect_terminal_outcome_unconfirmed', 'durable_job_binding_mismatch', 'empty_change', 'empty_source_proposal', 'execution_locks_unconfirmed', 'executor_exclusion_unconfirmed', 'executor_lock_already_held', 'executor_lock_identity_changed', 'executor_lock_not_held', 'existing_continuation_or_tail_inspect_only', 'existing_credential_shape_invalid', 'existing_preparation_inspect_only', 'existing_protected_artifact', 'existing_reconciled_validation_inspect_no_retry', 'existing_registration_files_unconfirmed', 'existing_registration_requires_reconciliation_no_retry', 'existing_review_inspect_only', 'existing_source_intent_requires_reconciliation', 'existing_storage_reservation_inspect_only', 'existing_systemd_credential_binding_required', 'existing_validation_requires_inspection', 'external_admin_state_unconfirmed', 'fixed_bootstrap_arguments', 'fixed_component_job_instance_required', 'fixed_job_action_required', 'fixed_job_launch_output_limit', 'fixed_validation_instance_required', 'full_admin_operation_active_or_unknown', 'functional_actual_function_mismatch', 'functional_after_outcome_unknown_inspect_no_retry', 'functional_before_failure_not_proved', 'functional_canonical_source_changed', 'functional_canonical_source_unconfirmed', 'functional_component_not_implemented', 'functional_evidence_identity_mismatch', 'functional_evidence_time_unconfirmed', 'functional_live_properties_not_observed', 'functional_loaded_identity_unconfirmed', 'functional_native_properties_unconfirmed', 'functional_native_unit_unconfirmed', 'functional_probe_clock_unconfirmed', 'functional_probe_frame_invalid', 'functional_probe_not_passed', 'functional_proof_incomplete', 'functional_source_or_time_mismatch', 'functional_verification_not_ready', 'global_effect_in_flight_or_unknown', 'guard_only_arguments_required', 'guard_only_request_required', 'historical_deployment_correction_unconfirmed', 'historical_deployment_link_unconfirmed', 'host_resources_unavailable', 'identity_refused', 'immutable_validation_harness_changed', 'initial_component_profile_scope', 'initial_preparation_id_preexists', 'initial_profile_not_supported', 'initial_proposal_not_registered', 'initial_public_before_changed', 'initial_public_before_metadata_changed', 'initial_public_flow_hash_changed', 'initial_public_scope_bound', 'initial_registered_files_changed', 'initial_registered_proposal_changed', 'initial_registered_proposal_conflict', 'initial_registered_request_changed', 'initial_registration_afterimage_unconfirmed', 'initial_registration_capacity_changed', 'initial_registration_capacity_or_reservation', 'initial_registration_completion_margin', 'initial_registration_entry_invalid', 'initial_registration_id_conflict', 'initial_registration_identity_invalid', 'initial_registration_journal_changed', 'initial_registration_not_committed', 'initial_registration_record_invalid', 'initial_registration_requires_live_send', 'initial_registration_result_invalid', 'initial_registration_state_invalid', 'initial_registration_storage_capacity', 'initial_request_bound', 'initial_request_id_preexists', 'initial_review_id_preexists', 'initial_source_inventory_changed', 'initial_source_path_changed', 'initial_template_candidate_bound', 'initial_template_hash_changed', 'initial_template_policy_only', 'initial_template_shape_changed', 'initial_template_source_scope_changed', 'initial_workflow_id_preexists', 'internal_component_request_invalid', 'internal_preparation_fields', 'internal_seal_fields', 'invalid_bound_identity', 'invalid_component_request', 'invalid_operation_id', 'invalid_root_dependency_hash', 'invalid_root_source_hash', 'invalid_sha256', 'invalid_validation_proof', 'job_component_or_action_refused', 'job_review_identity_or_expiry', 'job_start_not_confirmed', 'legacy_admin_effect_busy_or_uncertain', 'legacy_attempt_accounting_unconfirmed', 'legacy_operation_busy_or_uncertain', 'loaded_baseline_not_proved', 'loaded_precondition_does_not_match_bound_operation', 'loaded_version_changed_or_unknown', 'maintenance_lease_already_held', 'maintenance_lock_identity_changed', 'maintenance_lock_not_held', 'native_compensation_binding', 'native_lock_inventory_limit', 'native_maintenance_processing', 'native_no_effect_not_proved', 'native_operations_lock_identity', 'native_peer_does_not_hold_operations_lock', 'native_peer_pid_required', 'native_trigger_identity_changed', 'new_public_directory_metadata', 'nonfinite_json', 'observation_lease_completion_margin', 'observation_nonce_conflict', 'observation_principal_mismatch', 'observation_security_cleanup_pending', 'old_candidate_flow_changed', 'one_admission_request_at_a_time', 'one_component_guard_frame_only', 'one_component_request_only', 'operation_capacity', 'operation_id_conflict', 'operation_id_refused', 'operation_not_found', 'operator_binding_limit', 'operator_lease_completion_margin', 'operator_root_lease_changed', 'operator_root_lease_expired', 'other_component_effect_busy_or_uncertain', 'other_component_job_launch_or_effect_unknown', 'other_component_security_cleanup_unconfirmed', 'other_component_terminal_proof_missing', 'other_send_reserved_or_uncertain', 'other_task_reserved_or_uncertain', 'own_apply_source_receipt_required', 'own_component_job_unconfirmed', 'own_source_restore_unconfirmed', 'owner_lease_duration_invalid', 'owner_lease_hash_invalid', 'owner_lease_operation_invalid', 'owner_lease_profile_invalid', 'owner_lease_receipt_changed', 'owner_lease_rule_identity_changed', 'owner_lease_scope_changed', 'owner_root_lease_expired', 'parent_deadline_refused', 'parent_receipt_limit', 'parent_result_requires_reconciliation', 'partial_admission_frame', 'preparation_binding_refused', 'preparation_capacity', 'preparation_completion_margin', 'preparation_expired', 'preparation_identity_or_window', 'preparation_observation_revoked', 'preparation_observation_scope', 'preparation_storage_slots_full', 'prepared_input_limit', 'preparer_storage_capacity', 'preparer_storage_depth_bound', 'preparer_storage_inode_bound', 'preparer_storage_worstcase_capacity', 'previous_attempt_not_preexec_terminal', 'previous_validation_changed', 'protected_baseline_port_required', 'protected_before_effect_hook_required', 'protected_file_identity', 'protected_observation_capacity', 'protected_observation_missing', 'protected_observation_not_clean', 'protected_observation_reason', 'protected_observation_shape', 'protected_observation_stale', 'protected_observation_unknown_shape', 'protected_preparation_binding_changed', 'protected_preparation_capacity', 'protected_preparation_expiry', 'protected_preparation_id_conflict', 'protected_preparation_not_registered', 'protected_preparation_shape', 'protected_preparation_window', 'protected_prepared_record_refused', 'protected_prepared_scope_refused', 'protected_publisher_source_changed', 'protected_review_binding_mismatch', 'protected_review_capacity', 'protected_review_id_conflict', 'protected_review_not_registered', 'protected_review_ports_required', 'protected_validation_state_unknown', 'protected_validation_terminal_receipt_required', 'protected_validator_port_not_bound', 'protected_writer_review_shape', 'protected_writer_review_window', 'public_awk_binary_unconfirmed', 'public_directory_component_refused', 'public_snapshot_path_refused', 'public_snapshot_source_changed', 'public_snapshot_total_bound', 'publication_access_revoked', 'publication_component_not_admitted', 'publication_directories_collide', 'publication_directory_replaced', 'publication_file_changed_during_read', 'publication_principal_mismatch', 'publication_receipt_shape', 'publication_receipt_unconfirmed', 'publication_resources_or_window_unconfirmed', 'publication_worker_deadline', 'publication_worker_error_limit', 'publication_worker_output_limit', 'publication_worker_receipt_unconfirmed', 'publication_worker_reply_unconfirmed', 'published_record_changed', 'readonly_authentication_frame_limit', 'readonly_component_ledger', 'readonly_component_not_activated', 'readonly_identity_set_required', 'readonly_ledger_initialization_refused', 'readonly_worker_error_limit', 'readonly_worker_frame_invalid', 'readonly_worker_output_limit', 'readonly_worker_reply_identity', 'readonly_worker_source_changed', 'readonly_worker_source_scope', 'readonly_worker_timeout', 'receipt_size_limit', 'reciprocal_operations_lock_not_held', 'recorded_task_send_unconfirmed', 'registry_identity_changed', 'registry_timestamp_unconfirmed', 'render_payload_not_bound', 'render_result_hash_changed', 'repository_filesystem_above_limit', 'resource_gate_contract_changed', 'result_hash_conflict', 'review_action_refused', 'review_changed_during_publication_check', 'review_expiry_unconfirmed', 'review_record_shape', 'rollback_precondition_unconfirmed', 'root_admission_object_required', 'root_binary_changed', 'root_bootstrap_boot_changed', 'root_bootstrap_source_scope_changed', 'root_component_bootstrap_required', 'root_component_source_changed', 'root_dependency_changed', 'root_operator_decision_required', 'root_review_expired_or_changed', 'root_review_not_bound_to_actual_artifacts', 'root_selected_validation_required', 'root_validator_operation_required', 'sandbox_storage_limits_not_proved', 'scoped_nodes_file_bound', 'sealed_worker_source_changed', 'security_cleanup_unconfirmed', 'selected_validation_not_bound', 'shared_task_budget_exceeded', 'shared_task_policy_unconfirmed', 'snapshot_already_present', 'source_action_refused', 'source_bundle_hash', 'source_bundle_identity', 'source_changed_before_seal', 'source_changed_during_read', 'source_file_bound', 'source_file_unsafe', 'source_foreign_change_blocks_restore', 'source_or_window_changed_after_validation', 'source_owner_window_expired', 'source_path_not_closed', 'source_profile_bound', 'source_profile_component_refused', 'source_review_expired_midoperation', 'source_review_not_current', 'source_symlink_refused', 'source_text_bound', 'specific_validation_reconciliation_required', 'standing_goal_approval_changed', 'standing_goal_reference_changed', 'state_storage_capacity', 'storage_lock_identity', 'storage_operation_id', 'storage_reservation_shape', 'symlink_bound_parent', 'symlink_state_parent', 'task_admission_revoked', 'task_guard_already_held', 'task_guard_not_held', 'task_identity_not_admitted', 'task_not_registered', 'task_phase_binding_changed', 'task_phase_capacity', 'task_phase_receipt_limit', 'task_phase_request_changed', 'task_phase_start_unconfirmed', 'task_request_completion_margin', 'task_request_expiry_changed', 'uncertain_or_active_reservation_cannot_release', 'uncertain_or_applied_operation_cannot_cancel', 'unexpected_storage_file', 'unexpected_storage_reservation', 'unexpected_storage_symlink', 'unit_policy_hash_changed', 'unit_policy_hash_required', 'unknown_component_ledger_version', 'unknown_native_mutation_scope', 'unsafe_bootstrap_binary', 'unsafe_bootstrap_file', 'unsafe_bootstrap_parent', 'unsafe_bound_file', 'unsafe_component_ledger', 'unsafe_component_parent', 'unsafe_harness_runtime_directory', 'unsafe_initial_component_state', 'unsafe_protected_directory', 'unsafe_review_directory', 'unsafe_review_parent', 'unsafe_root_component_parent', 'unsafe_state_database', 'unsafe_systemd_credential', 'unsafe_systemd_credential_directory', 'unsafe_trigger_directory', 'unsafe_trigger_parent', 'unsafe_worker_state_folder', 'unsafe_worker_state_parent', 'validation_attempt_id_refused', 'validation_compatibility_shape', 'validation_job_not_registered', 'validation_lease_completion_margin', 'validation_mutex_replaced', 'validation_mutex_symlink', 'validation_not_accepted', 'validation_selection_artifact_changed', 'validation_selection_not_actual_success', 'validation_selection_profile_or_history_changed', 'validation_selection_shape', 'validation_start_not_confirmed', 'validator_live_properties_not_observed', 'validator_native_command_not_proved', 'validator_native_properties_not_proved', 'validator_native_run_failed', 'validator_negative_probes_not_proved', 'validator_process_exit_not_proved', 'validator_result_shape', 'validator_trusted_output_shape', 'wire_shape_refused', 'worker_action_refused', 'worker_deadline_unknown', 'worker_no_effect_receipt_unconfirmed', 'worker_receipt_content_refused', 'worker_receipt_identity_mismatch', 'worker_receipt_loaded_version_mismatch', 'worker_receipt_shape_refused', 'worker_receipt_time_unconfirmed', 'worker_source_scope_changed', 'worker_stderr_limit', 'worker_stdout_limit', 'worker_uncertainty_shape_refused'))
def child_limits(parent_pid):
 # The fixed child cannot outlive the process holding the admission locks.
 if _prctl(1,signal.SIGKILL,0,0,0)!=0 or os.getppid()!=parent_pid:os._exit(125)
 resource.setrlimit(resource.RLIMIT_CORE,(0,0));resource.setrlimit(resource.RLIMIT_CPU,(20,20));resource.setrlimit(resource.RLIMIT_NOFILE,(32,32))
def encoded(value):return (json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False)+'\n').encode()
def sha(value):return hashlib.sha256(encoded(value).rstrip(b'\n')).hexdigest()
def folder(path,owner):
 path=Path(path)
 for p in(path,*path.parents):need(not p.is_symlink(),'unsafe_worker_state_parent')
 s=path.stat();need(stat.S_ISDIR(s.st_mode)and s.st_uid==owner and stat.S_IMODE(s.st_mode)==0o700,'unsafe_worker_state_folder');return path
def read_json(path,owner,limit=16384):
 fd,_=safe_file(path,owner,0o600,limit)
 try:return json.loads(os.read(fd,limit+1))
 finally:os.close(fd)
def sync_folder(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(fd)
 finally:os.close(fd)
def write_new(path,value):
 raw=encoded(value);need(len(raw)<=16384,'parent_receipt_limit');fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:
  with os.fdopen(os.dup(fd),'wb')as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
 finally:os.close(fd)
 sync_folder(Path(path).parent)

def admission_context(executor,tasks,maintenance,reviews,principal,resources,clock=time.time):
 """Nonblocking order: operations/admin -> tasks -> native maintenance.
 Caller must launch this job after the admitting MCP request releases its lock.
 """
 @contextlib.contextmanager
 def locked():
  with executor.locked(),tasks.locked(),maintenance:
   gate=ProtectedAdmission(tasks,maintenance,reviews,principal,executor,resources,clock)
   yield gate.check
 return locked

class BoundNodeRedParent:
 def __init__(self,entrypoint,source_hashes,prepared_root,state_root,locked_admission,existing_authentication,owner=0,timeout=75,clock=time.time,before_effect=None):
  self.entry=Path(entrypoint);self.hashes=source_hashes;self.prepared_root=Path(prepared_root);self.state_root=Path(state_root);self.admission=locked_admission;self.auth=existing_authentication;self.owner=owner;self.timeout=timeout;self.clock=clock
  need(type(timeout)in(int,float)and 0<timeout<=75,'parent_deadline_refused')
  need(before_effect is None or callable(before_effect),'protected_before_effect_hook_required');self.before_effect=before_effect
 def sources(self):
  expected={'nodered_job.cjs':self.entry,'nodered_effect.cjs':self.entry.parent/'nodered_effect.cjs','attestation_model.cjs':self.entry.parent.parent/'attestation_model.cjs'}
  need(set(self.hashes)==set(expected),'worker_source_scope_changed')
  for name,path in expected.items():
   fd,_=safe_file(path,self.owner,0o644,1048576)
   try:raw=os.read(fd,1048577)
   finally:os.close(fd)
   need(hashlib.sha256(raw).hexdigest()==self.hashes[name],'sealed_worker_source_changed')
 def prepared(self,op,action):
  ident(op);need(action in('apply','rollback'),'worker_action_refused');folder(self.prepared_root,self.owner)
  p=read_json(self.prepared_root/(op+'-'+action+'.json'),self.owner,1048576+8192)
  fields={'operation_id','task_id','principal_sha256','component_id','before_sha256','after_sha256','candidate_nodes'}
  need(isinstance(p,dict)and set(p)==fields and p['operation_id']==op,'protected_prepared_record_refused');ident(p['task_id']);ident(p['principal_sha256'],64);ident(p['before_sha256'],64);ident(p['after_sha256'],64)
  need(p['component_id']in('localizacao_pessoas','observacao_host')and isinstance(p['candidate_nodes'],list),'protected_prepared_scope_refused')
  return p,{**{k:v for k,v in p.items()if k!='candidate_nodes'},'action':action}
 def state(self,action):folder(self.state_root,self.owner);return folder(self.state_root/action,self.owner)
 def previous(self,binding):
  target=self.state(binding['action'])/binding['operation_id']
  if not os.path.lexists(target):return None
  folder(target,self.owner)
  unknown={**binding,'state':'uncertain','executor_terminal':False,'receipt_verified':False,'automatic_retry':False,'effect_repeated':False,'collection_error':'existing_worker_record_without_verified_terminal_receipt'}
  if not os.path.lexists(target/'identity.json'):return unknown
  identity=read_json(target/'identity.json',self.owner);need(identity.get('request_sha256')==sha(binding),'operation_id_conflict')
  if not os.path.lexists(target/'receipt.json'):return unknown
  r=read_json(target/'receipt.json',self.owner);need(isinstance(r,dict)and all(r.get(k)==v for k,v in binding.items()),'worker_receipt_identity_mismatch')
  need(r.get('state')in('applied','rejected_without_effect','uncertain')and type(r.get('executor_terminal'))is bool and type(r.get('session_revoked'))is bool and r.get('security_cleanup_confirmed')is r['session_revoked']and r.get('receipt_verified')is True,'worker_receipt_shape_refused')
  at=r.get('worker_finished_at');need(type(at)in(int,float)and math.isfinite(at)and 0<=at<=self.clock()+1,'worker_receipt_time_unconfirmed')
  allowed=set(binding)|{'state','collection_error','executor_terminal','definitive_no_effect','loaded_sha256','other_scope_preserved_by_submission','effect_attempted','session_revoked','security_cleanup_confirmed','worker_finished_at','automatic_retry','receipt_verified'}
  reasons={None,'revision_conflict','effect_outcome_unconfirmed','pre_effect_validation_or_collection_failed','parent_admission_or_setup_refused','protected_admission_refused_before_authentication','worker_exit_without_verified_receipt'}
  need(set(r)<=allowed and r.get('automatic_retry')is False and type(r.get('effect_attempted'))is bool and r.get('collection_error')in reasons,'worker_receipt_content_refused')
  if r['state']=='uncertain':need(r['executor_terminal']is False and r.get('definitive_no_effect')is not True,'worker_uncertainty_shape_refused')
  if r['state']=='applied':need(r.get('loaded_sha256')==binding['after_sha256']and r['executor_terminal']is True,'worker_receipt_loaded_version_mismatch')
  if r['state']=='rejected_without_effect':need(r.get('definitive_no_effect')is True and r['executor_terminal']is True,'worker_no_effect_receipt_unconfirmed')
  return r
 def rejected(self,binding,reason,diagnostic=None):
  # Only before launch, or after exit with zero positive admission grants.
  # Pinned NodeRedWorker authenticates only after its initial grant succeeds.
  state=self.state(binding['action']);entries=list(state.iterdir());need(len(entries)<64,'operation_capacity')
  total=sum(p.stat(follow_symlinks=False).st_size for d in entries if d.is_dir()for p in d.iterdir());need(total+32768<=32*1048576,'state_storage_capacity')
  target=state/binding['operation_id'];target.mkdir(mode=0o700);sync_folder(state)
  write_new(target/'identity.json',{**binding,'request_sha256':sha(binding)})
  receipt={**binding,'state':'rejected_without_effect','executor_terminal':True,'definitive_no_effect':True,'effect_attempted':False,'session_revoked':True,'security_cleanup_confirmed':True,'worker_finished_at':self.clock(),'automatic_retry':False,'receipt_verified':True,'collection_error':reason}
  if diagnostic is not None:write_new(target/'diagnostic.json',diagnostic)
  write_new(target/'receipt.json',receipt);return self.previous(binding)
 def run(self,op,action):
  self.sources();prepared,binding=self.prepared(op,action);old=self.previous(binding)
  if old is not None:return {**old,'duplicate':True,'effect_repeated':False}
  launched=False;grants=0;proc=None;failure='parent_admission_or_setup_refused';stage='admission_enter';diagnostic=None;parent=None;child=None;auth_r=None;auth_w=None;stack=contextlib.ExitStack()
  try:
   check=stack.enter_context(self.admission())
   stage='admission_check';check(binding)  # Before reading existing credentials or starting a child.
   stage='socketpair';parent,child=socket.socketpair()
   stage='pipe';auth_r,auth_w=os.pipe()
   stage='authentication';authentication=self.auth()
   stage='state_folder';state_folder=str(self.state(action))
   stage='operator_encoding';operator={'authentication':authentication,'state_folder':state_folder};secret=encoded(operator);authentication=None
   stage='operator_binding_limit';need(len(secret)<=8192,'operator_binding_limit')
   env={'PATH':'/usr/bin:/bin','LC_ALL':'C','COMPONENT_ADMISSION_FD':str(child.fileno()),'COMPONENT_AUTH_FD':str(auth_r)}
   parent_pid=os.getpid()
   stage='child_launch'
   proc=subprocess.Popen(['/usr/bin/node','--jitless','--no-expose-wasm','--max-old-space-size=32',str(self.entry)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=(child.fileno(),auth_r),env=env,close_fds=True,preexec_fn=lambda:child_limits(parent_pid))
   launched=True;deadline=time.monotonic()+self.timeout;child.close();child=None;os.close(auth_r);auth_r=None
   stage='authentication_pipe_write';view=memoryview(secret)
   while view:view=view[os.write(auth_w,view):]
   view=None;secret=None;operator=None;os.close(auth_w);auth_w=None
   stage='prepared_input_write';body=encoded({'action':action,'prepared':prepared});need(len(body)<=1048576+8192,'prepared_input_limit');proc.stdin.write(body);proc.stdin.close()
   stage='child_io';buffer=b'';sequence=0;stdout_bytes=stderr_bytes=0
   with selectors.DefaultSelector()as selector:
    selector.register(parent,selectors.EVENT_READ,'admission');selector.register(proc.stdout,selectors.EVENT_READ,'stdout');selector.register(proc.stderr,selectors.EVENT_READ,'stderr')
    while selector.get_map():
     need(time.monotonic()<deadline,'worker_deadline_unknown')
     for key,_ in selector.select(min(.1,max(0,deadline-time.monotonic()))):
      data=os.read(key.fileobj.fileno(),4096)
      if not data:selector.unregister(key.fileobj);continue
      if key.data=='stdout':stdout_bytes+=len(data);need(stdout_bytes<=16384,'worker_stdout_limit')
      elif key.data=='stderr':stderr_bytes+=len(data);need(stderr_bytes<=8192,'worker_stderr_limit')
      else:
       buffer+=data;need(len(buffer)<=4096,'admission_frame_limit')
       if b'\n'not in buffer:continue
       raw,buffer=buffer.split(b'\n',1);need(not buffer,'one_admission_request_at_a_time');request=json.loads(raw)
       need(isinstance(request,dict)and set(request)=={'version','sequence','binding'}and request['version']==1 and type(request['sequence'])is int and request['sequence']==sequence+1 and sequence<2 and request['binding']==binding,'admission_frame_binding_refused');sequence+=1
       try:
        grant=check(binding)
        # Second child request is after GET/base/delta verification and before
        # its intent/POST. Canonical source commit shares all Root locks.
        if sequence==2 and self.before_effect is not None:
         self.before_effect(binding,check)
         grant=check(binding)  # Fresh again after canonical CAS, never stale grant.
        reply={'version':1,'sequence':sequence,'ok':True,'grant':grant};grants+=1
       except Exception:reply={'version':1,'sequence':sequence,'ok':False}
       parent.sendall(encoded(reply))
   proc.wait(timeout=max(.01,deadline-time.monotonic()));need(not buffer,'partial_admission_frame');failure='worker_exit_without_verified_receipt'
   receipt=self.previous(binding)
   if receipt is not None:return receipt
   if grants==0:return self.rejected(binding,'protected_admission_refused_before_authentication')
  except BaseException as error:
   allowed={'PermissionError','FileNotFoundError','ValueError','OSError','RuntimeError','SubprocessError','TypeError','BrokenPipeError','JSONDecodeError','TimeoutError','MemoryError'}
   reason=str(error)if type(error)is ValueError and str(error)in DIAGNOSTIC_CODES else None
   number=getattr(error,'errno',None);number=number if type(number)is int and 0<=number<=4095 else None
   diagnostic={'source':'protected_parent_setup_diagnostic','operation_id':op,'action':action,'observed_at':self.clock(),'stage':stage,'exception_kind':type(error).__name__ if type(error).__name__ in allowed else'Error','errno':number,'reason_code':reason,'child_launched':launched,'positive_grants':grants,'automatic_retry':False,'not_effect_or_functional_proof':True}
   if proc is not None and proc.poll()is None:
    proc.kill();proc.wait(timeout=2)
   if not isinstance(error,Exception):raise
   receipt=self.previous(binding)
   if receipt is not None:return receipt
   if not launched or grants==0:
    try:return self.rejected(binding,failure,diagnostic)
    except Exception:pass
  finally:
   if proc is not None and proc.poll()is None:
    proc.kill();proc.wait(timeout=2)
   for obj in(parent,child):
    if obj is not None:obj.close()
   for fd in(auth_r,auth_w):
    if fd is not None:os.close(fd)
   if proc is not None:
    for stream in(proc.stdin,proc.stdout,proc.stderr):
     if stream is not None and not stream.closed:stream.close()
   stack.close()
  return {**binding,'state':'uncertain','executor_terminal':False,'receipt_verified':False,'automatic_retry':False,'effect_repeated':False,'collection_error':'parent_worker_outcome_unconfirmed'}
