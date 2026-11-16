"""Pure derivation: let the maintenance gateway see a Root-proven own rollback as completed.

cg_completed (client continuation dispatch readiness) requires every client lifecycle
row to be observed. It already accepts the Root post-start proof for installs, but not
the Root rollback-completion proof that native_binding.py accepts, so one proven own
rollback kept continuation dispatch closed. The same immutable checks are applied here:
proof source and operation, exact lifecycle/file/reference receipt bytes, a ``rollback``
lifecycle uncertain only in a start phase, restored file and reference receipts.

Only owner-policy core_sources.gateway.py pins the gateway source.
"""
import hashlib
import json

ANCHOR_OLD = "  value=ps_terminal_cutover(value.get('operation_id'))or value\n"
ANCHOR_NEW = ("  value=ps_terminal_cutover(value.get('operation_id'))or value\n"
              "  if value.get('state')=='uncertain_observe_only'and value.get('verb')=='rollback'and cg_rollback_completed(value.get('operation_id'),raw):\n"
              "   value={**value,'state':'own_client_rollback_observed'}\n")
FUNCTION_ANCHOR = "def cg_completed(owner):"
FUNCTION = '''def cg_rollback_completed(op,lifecycle_raw):
 # Same immutable Root rollback-completion proof that native_binding.py accepts.
 try:
  sc_need(type(op)is str and re.fullmatch('[a-f0-9]{32}',op),'rollback_completion_operation')
  base=Path('/var/lib/raspberry-maintenance-install')
  try:proof=json.loads(cg_read(base/'client-lifecycle'/'rollback-completions'/(op+'.json'),16384))
  except FileNotFoundError:return False
  sc_need(type(proof)is dict and proof.get('source')=='Root_observed_own_rollback_completion_v1'and proof.get('operation_id')==op,'rollback_completion_schema')
  file_raw=cg_read(base/'receipts'/(op+'.json'),3145728);refs_raw=cg_read(base/'client-lifecycle'/'source-refs'/(op+'.json'),3145728)
  sc_need(cg_hashlib.sha256(lifecycle_raw).hexdigest()==proof.get('lifecycle_sha256')and cg_hashlib.sha256(file_raw).hexdigest()==proof.get('file_sha256')
          and cg_hashlib.sha256(refs_raw).hexdigest()==proof.get('references_sha256'),'rollback_completion_evidence_changed')
  life,file,refs=json.loads(lifecycle_raw),json.loads(file_raw),json.loads(refs_raw)
  sc_need(life.get('state')=='uncertain_observe_only'and life.get('verb')=='rollback'and life.get('phase')in('events_start_pending','socket_start_pending','tunnel_start_pending')
          and file.get('state')=='own_rollback_configuration_only'and file.get('own_sources_restored')is True and file.get('rollback_after_hashes')==proof.get('live_sources')
          and refs.get('state')=='references_restored'and refs.get('restore')is True and refs.get('after_hashes')==proof.get('live_references')
          and proof.get('services')=={'events':'active','socket':'active','tunnel':'active'},'rollback_completion_receipts')
  return True
 except (OSError,ValueError,KeyError,TypeError):return False

'''


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def swap(body, old, new, reason):
    need(body.count(old) == 1 and body.count(new) == 0, reason)
    return body.replace(old, new)


def derive(gateway, owner_policy):
    need(b'cg_rollback_completed' not in gateway, 'gateway_already_patched')
    after = swap(gateway, ANCHOR_OLD.encode(), ANCHOR_NEW.encode(), 'gateway_completed_anchor')
    after = swap(after, FUNCTION_ANCHOR.encode(), FUNCTION.encode() + FUNCTION_ANCHOR.encode(), 'gateway_function_anchor')
    owner = swap(owner_policy, sha(gateway).encode(), sha(after).encode(), 'owner_gateway_pin')
    a, b = json.loads(owner), json.loads(owner_policy)
    b['core_sources']['gateway.py'] = sha(after)
    need(a == b, 'owner_policy_changed_beyond_pin')
    return after, owner
