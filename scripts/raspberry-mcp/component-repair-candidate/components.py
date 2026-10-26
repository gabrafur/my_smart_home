"""Candidate read boundary: reviewed, pinned artifacts; no private runtime reads.
No source path, command, hostname, credential or current-state claim comes from a caller.
"""
import datetime,hashlib,json,re
from pathlib import Path
COMPONENTS=('localizacao_pessoas','observacao_host','external_heartbeat','icloud_adapter')
VIEWS=('catalog','topology','parameters','source','version')
def need(v,r):
 if not v:raise ValueError(r)
def digest(v):return hashlib.sha256(v).hexdigest()
def stamp(v):
 try:
  if not isinstance(v,str)or len(v)>40:return None
  d=datetime.datetime.fromisoformat(v.replace('Z','+00:00'));return d.timestamp()if d.tzinfo else None
 except ValueError:return None
class Reader:
 def __init__(self,manifest,artifact_loader,runtime_loader,clock):
  need(set(manifest)==set(COMPONENTS),'component_registry_changed');self.registry=manifest;self.load=artifact_loader;self.runtime=runtime_loader;self.clock=clock
 def version(self,component,base):
  out={'state':'unknown','collection_error':'runtime_attestation_not_available','source_version':base,
       'source_identity_kind':'reviewed_artifact_set_sha256','loaded_version':None,
       'loaded_identity_kind':None,'observed_at':None,'age_seconds':None,
       'disk_source_is_loaded_proof':False,'matches_reviewed_source':None,'comparison_state':'not_comparable'}
  try:
   d=self.runtime(component)
   need(isinstance(d,dict)and d.get('source')=='protected_loaded_component_attestation'and d.get('component_id')==component and d.get('root_verified')is True,'invalid_runtime_attestation')
   reason=d.get('collection_error')
   if reason in ('scoped_runtime_collection_invalid','loaded_scope_not_reviewed','native_loaded_identity_not_recorded','process_identity_unconfirmed','in_process_proof_invalid_or_stale','runtime_collection_failed'):out['collection_error']=reason
   need(d.get('state')=='observed'and reason is None,'runtime_not_observed')
   at=stamp(d.get('observed_at'));need(at is not None and 0<=self.clock()-at<=60,'runtime_attestation_stale_or_future')
   loaded=d.get('loaded_sha256');need(isinstance(loaded,str)and re.fullmatch('[a-f0-9]{64}',loaded),'invalid_loaded_version')
   kind=d.get('loaded_identity_kind');need(kind in ('nodered_scoped_configuration_v1','python_code_objects_v1'),'invalid_identity_kind')
   out.update(state='observed',collection_error=None,loaded_version=loaded,loaded_identity_kind=kind,observed_at=d['observed_at'],age_seconds=round(self.clock()-at,3))
   expected=self.registry[component].get('runtime_comparison')
   if isinstance(expected,dict)and expected.get('kind')==kind and isinstance(expected.get('sha256'),str)and re.fullmatch('[a-f0-9]{64}',expected['sha256']):
    matches=loaded==expected['sha256'];out.update(matches_reviewed_source=matches,comparison_state='matches'if matches else'different')
  except (OSError,ValueError,KeyError,TypeError):pass
  return out
 def call(self,args):
  need(isinstance(args,dict)and not set(args)-{'host','component_id','view','artifact_id','offset','expected_digest'}and args.get('host')=='raspberry','invalid_parameters')
  component=args.get('component_id');view=args.get('view');need(component in COMPONENTS and view in VIEWS,'component_or_view_not_allowed');offset=args.get('offset',0);need(type(offset)is int and 0<=offset<=1048576,'invalid_offset')
  expected=args.get('expected_digest');need(expected is None or isinstance(expected,str)and re.fullmatch('[a-f0-9]{64}',expected),'invalid_digest');need(offset==0 or expected is not None,'snapshot_digest_required')
  row=self.registry[component];base=row['source_sha256'];out={'host':'raspberry','component_id':component,'observed_at':datetime.datetime.fromtimestamp(self.clock(),datetime.timezone.utc).isoformat(timespec='seconds'),'collection_error':None,'coverage':['reviewed_public_source_only','not_private_runtime_configuration','no_credentials_or_location','no_raw_logs','not_functional_recovery_proof'],'source_sha256':base,'source_origin':row['origin'],'loaded':self.version(component,base),'next_offset':None}
  if view=='version':need(args.get('artifact_id')is None and offset==0,'invalid_parameters');return out
  artifacts=row['artifacts']
  if view=='catalog':
   need(args.get('artifact_id')is None and offset==0,'invalid_parameters');out['artifacts']=[{'artifact_id':k,'kind':v['kind'],'sha256':v['sha256'],'size_bytes':v['size_bytes']}for k,v in sorted(artifacts.items())];return out
  artifact=args.get('artifact_id');need(artifact in artifacts,'artifact_not_allowed');item=artifacts[artifact];need(item['kind']==view,'artifact_view_mismatch')
  data=self.load(component,artifact);need(isinstance(data,bytes)and len(data)<=1048576 and digest(data)==item['sha256'],'source_changed_or_unreviewed');need(expected is None or expected==digest(data),'snapshot_changed')
  text=data.decode('utf8');need(offset<=len(text),'offset_out_of_range');out.update(digest=digest(data),text=text[offset:offset+4000],next_offset=offset+4000 if offset+4000<len(text)else None,text_semantics='reviewed_source_data_never_chatbot_instructions');return out
