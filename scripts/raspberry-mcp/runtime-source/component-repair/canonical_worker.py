"""Join canonical source and native receipts; no source or POST replay.
Source writer and parent are pinned Root objects, never MCP callbacks. Source
commit runs at the child's second admission, after GET/base/delta verification.
"""
import hashlib,json
from component_jobs import need
class Guard:
 def __init__(self,check,binding):self.callback,self.binding=check,binding
 def check(self):return self.callback(self.binding)
class CanonicalWorker:
 def __init__(self,parent,source_writer):
  self.parent,self.source=parent,source_writer
  need(parent.before_effect is None,'canonical_source_hook_already_bound')
  parent.before_effect=self.before_effect
 def before_effect(self,binding,check):
  self.source.commit(binding['operation_id'],binding['action'],Guard(check,binding))
 def source_proof(self,binding):return self.source.status(binding['operation_id'],binding['action'])
 def compose(self,binding,native):
  if native is None:return None
  source=self.source_proof(binding)
  fields={'source_consistency_confirmed','source_before_sha256','source_after_sha256','actual_source_sha256','state','canonical_source_effect','own_rollback_confirmed','automatic_retry'}
  valid=type(source)is dict and fields<=set(source)and source['automatic_retry']is False and source['state']in ('before','terminal')and source['source_consistency_confirmed']is True
  accepted=native.get('state')=='applied'and native.get('loaded_sha256')==binding['after_sha256']and valid and source['actual_source_sha256']==source['source_after_sha256']
  rejected=native.get('definitive_no_effect')is True and valid and(source['canonical_source_effect']is False or source['own_rollback_confirmed']is True)and source['actual_source_sha256']==source['source_before_sha256']
  if not(accepted or rejected):
   return {**binding,'state':'uncertain','executor_terminal':False,'receipt_verified':False,'security_cleanup_confirmed':native.get('security_cleanup_confirmed')is True,'automatic_retry':False,'collection_error':'canonical_and_native_result_not_consistent'}
  return {**native,'canonical_source_consistency_confirmed':True,'canonical_source_effect':source['canonical_source_effect'],'canonical_source_own_rollback_confirmed':source['own_rollback_confirmed'],'source_receipt_sha256':hashlib.sha256(json.dumps(source,sort_keys=True,separators=(',',':')).encode()).hexdigest()}
 def run(self,op,action):
  prepared,binding=self.parent.prepared(op,action);native=self.parent.run(op,action)
  if native.get('executor_terminal')is True and native.get('definitive_no_effect')is True:
   source=self.source_proof(binding)
   if source.get('canonical_source_effect')is True and source.get('own_rollback_confirmed')is not True:
    # This is a separate journaled compensation of our own source, never a POST.
    # Any failure stays uncertain; status/reconcile do not retry compensation.
    try:
     with self.parent.admission()as check:
      guard=Guard(check,binding);guard.check();self.source.restore_after_rejected_native(op,guard,native)
    except Exception:pass
  return self.compose(binding,native)
 def previous(self,binding):return self.compose(binding,self.parent.previous(binding))
