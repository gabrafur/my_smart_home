"""Verbatim pre-patch excerpt of native_binding.ClientReferenceClosure.plan (fixture only)."""
import hashlib,json,re
def need(v,code):
    if not v:raise ValueError(code)
SC_SLOTS={'client_events_worker','client_continuation_policy','client_repair_projection','client_frontend_projection'}
REF_PATHS={'repair':'/usr/local/lib/raspberry-repair-control/policy.json','component':'/usr/local/lib/raspberry-component-repair/policy.json','job':'/etc/systemd/system/raspberry-component-job@.service','validate':'/etc/systemd/system/raspberry-component-validate@.service','guard':'/etc/systemd/system/raspberry-component-guard@.service'}
REF_VERBS={'job':'worker %i','validate':'validate %i','guard':'guard'}
REF_PROJECTOR='event_projection.mjs';REF_WORKER='/usr/local/lib/raspberry-mcp-events/worker.py'
class ClientReferenceClosure:
 def __init__(self,io,package):self.io,self.package=io,package
 def plan(self,restore=False):
  rows={r['slot']:r for r in self.package['files']};need(set(rows)==SC_SLOTS,'reference_client_scope')
  old='after_sha256'if restore else'before_sha256';new='before_sha256'if restore else'after_sha256'
  raw={key:self.io.ref_read(key)for key in REF_PATHS};repair=json.loads(raw['repair']);component=json.loads(raw['component'])
  need(repair['source_hashes'][REF_PROJECTOR]==rows['client_repair_projection'][old],'reference_projector_foreign')
  need(component['dependencies'][REF_WORKER]==rows['client_events_worker'][old],'reference_worker_foreign')
  need(component['dependencies'][REF_PATHS['repair']]==hashlib.sha256(raw['repair']).hexdigest(),'reference_policy_chain_unconfirmed')
  wanted_repair=json.loads(raw['repair']);wanted_repair['source_hashes'][REF_PROJECTOR]=rows['client_repair_projection'][new]
  result={'repair':(json.dumps(wanted_repair,indent=2)+'\n').encode()}
  wanted_component=json.loads(raw['component']);wanted_component['dependencies'][REF_WORKER]=rows['client_events_worker'][new];wanted_component['dependencies'][REF_PATHS['repair']]=hashlib.sha256(result['repair']).hexdigest();result['component']=(json.dumps(wanted_component,indent=2)+'\n').encode()
  before=hashlib.sha256(raw['component']).hexdigest();after=hashlib.sha256(result['component']).hexdigest()
  for key,verb in REF_VERBS.items():
   line='ExecStart=/usr/bin/python3 -I -S -B /usr/local/lib/raspberry-component-repair/root_bootstrap.py '+before+' '+verb
   text=raw[key].decode();need(sum(x==line for x in text.splitlines())==1 and text.count(before)==1,'reference_unit_foreign')
   result[key]=text.replace(before,after,1).encode()
  return raw,result
