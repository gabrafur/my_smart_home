"""Candidate fixed readonly bridge. No caller arguments or privileged writes."""
import copy,datetime,json,math,re,socket,time
REQUEST={'tool':'icloud_readiness','host':'raspberry','component_id':'icloud_adapter'}
COVERAGE=['fixed_native_process_proof_and_nonce_binding','fixed_readonly_HA_service_registry','entry_ready_and_registration_are_not_handler_or_Apple_health','no_credentials_location_raw_logs_or_prompts','not_Eva_execution_or_full_goal_acceptance']
PHASES=('entry_ready','entry_waiting_user','entry_contained','domain_loaded')
ERRORS=('starting','transport_unconfirmed','response_refused','invalid_response','scope_expired','scope_revoked','connection_unverified','source_invalid_or_unavailable','service_observation_stale_or_invalid')
def need(v):
 if not v:raise ValueError('readiness_reply_invalid')
def age(value,now):
 need(isinstance(value,str)and len(value)<=40);d=datetime.datetime.fromisoformat(value.replace('Z','+00:00'));need(d.tzinfo is not None);a=now-d.timestamp();need(math.isfinite(a)and a>=0);return a
def sha(v):return isinstance(v,str)and re.fullmatch('[a-f0-9]{64}',v)is not None
def unknown(now):return {'source':'fixed_icloud_loaded_and_service_observation','component_id':'icloud_adapter','observed_at':datetime.datetime.fromtimestamp(now,datetime.timezone.utc).isoformat(),'state':'unknown','collection_error':'root_readiness_unavailable','loaded':None,'service_registration':None,'functional_health':'unknown','functional_recovery_proven':False,'automatic_retry':False}
def project(value,now):
 try:
  need(isinstance(value,dict)and set(value)=={'source','component_id','observed_at','state','collection_error','loaded','expected_node_contract','service_registration','functional_health','functional_recovery_proven','service_call_executed','authentication_or_location_refresh_called','coverage'})
  need(value['source']=='fixed_icloud_loaded_and_service_observation'and value['component_id']=='icloud_adapter'and age(value['observed_at'],now)<=10 and value['functional_health']=='unknown'and all(value[k]is False for k in ('functional_recovery_proven','service_call_executed','authentication_or_location_refresh_called'))and value['coverage']==COVERAGE)
  expected={'source':'reviewed_NodeRED_contract_not_live_configuration','service':'public_bindings.call','action':'refresh_location','current_NodeRED_configuration_observed':False};need(value['expected_node_contract']==expected and value['expected_node_contract'].get('current_NodeRED_configuration_observed')is False)
  v=copy.deepcopy(value);loaded=v['loaded'];service=v['service_registration'];need(isinstance(loaded,dict)and isinstance(service,dict))
  if loaded.get('state')=='observed':
   need(set(loaded)=={'state','collection_error','observed_at','age_seconds','code_sha256','identity_kind','release_revision','entry_phase','native_process_identity_verified'}and loaded['collection_error']is None and sha(loaded['code_sha256'])and sha(loaded['release_revision'])and loaded['identity_kind']=='python_code_objects_v1'and loaded['entry_phase']in PHASES and loaded['native_process_identity_verified']is True);seconds=age(loaded['observed_at'],now);need(seconds<=60);loaded['age_seconds']=round(seconds,3)
  else:
   need(loaded=={'state':'unknown','collection_error':'process_or_proof_unconfirmed','observed_at':None,'age_seconds':None,'code_sha256':None,'release_revision':None,'entry_phase':'unknown'})
  need(set(service)=={'state','collection_error','observed_at','age_seconds','service','registered','last_success'}and service['service']=='public_bindings.call')
  last=service['last_success']
  if last is not None:need(isinstance(last,dict)and set(last)=={'observed_at','registered','historical_not_current'}and type(last['registered'])is bool and last['historical_not_current']is True);age(last['observed_at'],now)
  if service.get('state')=='observed':need(service['collection_error']is None and type(service['registered'])is bool and age(service['observed_at'],now)<=90);service['age_seconds']=round(age(service['observed_at'],now),3)
  else:
   need(service.get('state')=='unknown'and service['collection_error']in ERRORS and service['registered']is None)
   if service['observed_at']is not None:service['age_seconds']=round(age(service['observed_at'],now),3)
   else:need(service['age_seconds']is None)
  both=loaded['state']==service['state']=='observed';need(v['state']==('observed'if both else'unknown')and v['collection_error']==(None if both else'partial_collection_failure'));return v
 except Exception:return unknown(now)
def collect(clock=time.time):
 now=clock()
 try:
  with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)as s:
   s.settimeout(6);s.connect('/run/raspberry-admin-executor.sock');s.sendall(json.dumps(REQUEST,separators=(',',':')).encode()+b'\n');raw=bytearray()
   while b'\n'not in raw:
    part=s.recv(2048);need(part and len(raw)+len(part)<=8192);raw.extend(part)
   need(raw.count(b'\n')==1 and raw.endswith(b'\n'));value=json.loads(raw)
  return project(value,clock())
 except Exception:return unknown(now)
