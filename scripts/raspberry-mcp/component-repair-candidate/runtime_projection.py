"""Candidate projections. No filesystem, process, authentication or network effects."""
import datetime as dt
import re
KINDS=('nodered_scoped_configuration_v1','python_code_objects_v1')
CATEGORIES=frozenset(('dns_resolution_error','tls_certificate_error','tls_error','timeout_exception','connection_error','http_protocol_error','os_error','transport_exception_unclassified','unexpected_provider_response','http_refused','not_recorded'))
def stamp(value):
 try:
  if not isinstance(value,str)or len(value)>40:return None
  at=dt.datetime.fromisoformat(value.replace('Z','+00:00'));return at.timestamp()if at.tzinfo else None
 except ValueError:return None
def sha(value):return isinstance(value,str)and re.fullmatch('[a-f0-9]{64}',value)is not None
def unknown(component,now,reason):
 return {'source':'protected_loaded_component_attestation','component_id':component,'root_verified':False,'state':'unknown','observed_at':dt.datetime.fromtimestamp(now,dt.timezone.utc).isoformat(),'loaded_sha256':None,'loaded_identity_kind':'python_code_objects_v1','collection_error':reason,'coverage':['no_private_configuration_or_logs_exported','not_functional_recovery_proof']}
def project_icloud(proof,binding,expected_release,now):
 out=unknown('icloud_adapter',now,'in_process_proof_invalid_or_stale')
 if not isinstance(proof,dict)or not isinstance(binding,dict):return out
 if binding.get('process_identity_verified')is not True:return {**out,'collection_error':'process_identity_unconfirmed'}
 at=stamp(proof.get('observed_at'))
 if (at is None or not 0<=now-at<=60 or proof.get('schema_version')!=1 or proof.get('source')!='homeassistant.main_process.icloud'
     or not isinstance(binding.get('operation_id'),str)or not re.fullmatch('[a-f0-9]{32}',binding['operation_id'])
     or proof.get('operation_id')!=binding['operation_id']or not sha(expected_release)
     or proof.get('release_revision')!=expected_release or binding.get('release_revision')!=expected_release
     or not sha(proof.get('loaded_code_sha256'))or proof.get('ha_running')is not True or proof.get('manual_auth_guard_loaded')is not True):return out
 phase=proof.get('phase');phase=phase if phase in ('entry_ready','entry_waiting_user','entry_contained','domain_loaded')else'unknown'
 return {**out,'state':'observed','observed_at':proof['observed_at'],'loaded_sha256':proof['loaded_code_sha256'],'collection_error':None,
  'reviewed_release_revision':expected_release,'entry_phase':phase,'remote_functional_health':'unknown','process_identity_verified':True,
  'coverage':['actual_HA_process_code_object_fingerprint','reviewed_release_marker_and_existing_nonce','not_source_file_identity_equality','not_remote_icloud_or_location_health','no_authentication_or_location_refresh_called']}
def project_heartbeat(status,now,binding=None):
 out=unknown('external_heartbeat',now,'native_loaded_identity_not_recorded')
 out['diagnostics']={'state':'unknown','collection_error':'runtime_collection_failed'}
 if not isinstance(status,dict)or status.get('source')!='bounded_local_heartbeat_history':return out
 at=stamp(status.get('observed_at'));sample=stamp(status.get('last_sample_observed_at'))
 state=status.get('last_sample_state');http=status.get('last_http_status')
 if at is None or sample is None or not 0<=now-at<=120 or not 0<=now-sample<=120 or state not in ('provider_accepted','provider_refused','uncertain','unknown'):return out
 http=http if type(http)is int and 100<=http<=599 else None
 data={'state':'observed','collection_error':None,'observed_at':status['observed_at'],'last_sample_observed_at':status['last_sample_observed_at'],'last_sample_state':state,'last_http_status':http,'coverage':['provider_acceptance_only','not_assistant_execution_or_household_health','not_loaded_code_identity'],'latest_failed_or_uncertain_sample':None}
 failure=status.get('latest_failed_or_uncertain_sample')
 if isinstance(failure,dict):
  failed_at=stamp(failure.get('observed_at'))
  if failed_at is not None and failed_at<=now and failure.get('state')in ('provider_refused','uncertain'):
   category=failure.get('failure_category');category=category if isinstance(category,str)and category in CATEGORIES else'not_recorded'
   data['latest_failed_or_uncertain_sample']={'observed_at':failure['observed_at'],'state':failure['state'],'failure_category':category,'is_latest_attempt':failure.get('is_latest_attempt')if type(failure.get('is_latest_attempt'))is bool else None,'sample_completion_recorded':failure.get('sample_completion_recorded')if type(failure.get('sample_completion_recorded'))is bool else None,'transport_outcome_not_service_health':True}
 out['diagnostics']=data
 proof=status.get('last_loaded_identity')
 if not isinstance(proof,dict):return out
 at=stamp(proof.get('observed_at'))
 if (type(proof.get('schema_version'))is not int or proof.get('schema_version')!=1 or proof.get('source')!='native_heartbeat.loaded_code' or proof.get('identity_kind')!='python_code_objects_v1'
     or at is None or not 0<=now-at<=120 or type(proof.get('sample_sequence'))is not int or type(status.get('last_sequence'))is not int or proof.get('sample_sequence')!=status.get('last_sequence')
     or not isinstance(proof.get('runtime_cache_tag'),str)or re.fullmatch('cpython-[0-9]{2,4}',proof['runtime_cache_tag'])is None
     or proof.get('critical_bindings_valid')is not True or not sha(proof.get('loaded_code_sha256'))or not sha(proof.get('critical_binding_sha256'))):return {**out,'collection_error':'native_loaded_identity_invalid_or_stale'}
 if (not isinstance(binding,dict)or binding.get('native_invocation_verified')is not True
     or proof['loaded_code_sha256']!=binding.get('expected_loaded_sha256')
     or proof['critical_binding_sha256']!=binding.get('expected_critical_binding_sha256')
     or proof.get('runtime_cache_tag')!=binding.get('expected_runtime_cache_tag')):return {**out,'collection_error':'native_loaded_identity_binding_unconfirmed'}
 return {**out,'state':'observed','observed_at':proof['observed_at'],'loaded_sha256':proof['loaded_code_sha256'],'collection_error':None,'native_invocation_identity_verified':True,
  'coverage':['actual_code_from_completed_native_invocation','systemd_invocation_PID_boot_and_monotonic_binding','critical_runtime_bindings_match_reviewed_source','not_currently_live_process_or_remote_health','not_assistant_execution_or_household_health']}
