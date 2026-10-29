"""Pure plan for one explicitly reviewed Codex control-socket replacement.

No discovery, filesystem writes, RPC, retries, automatic trust, or lease renewal.
The operator must attest the fixed listener, kernel peer and approved code,
then compare the original policy bytes immediately before publication.
"""
import copy
import hashlib
import json
import re

POLICIES={'legacy':'/usr/local/lib/raspberry-mcp/codex-control-approval.json',
          'task':'/usr/local/lib/raspberry-task-control/policy.json',
          'repair':'/usr/local/lib/raspberry-repair-control/policy.json'}

def need(ok,reason):
    if not ok:raise ValueError(reason)

def sha(raw):return hashlib.sha256(raw).hexdigest()
def encode(v):return (json.dumps(v,sort_keys=True,indent=2)+'\n').encode()

def candidates(before,attestation):
    need(type(before)is dict and set(before)==set(POLICIES)and
      all(type(v)is bytes and 0<len(v)<=1048576 for v in before.values()),'control_rebind_policy_scope')
    need(type(attestation)is dict and set(attestation)=={'socket_identity','peer_pid','peer_uid','peer_gid',
      'socket_uid','socket_mode','process_start_ticks','executable_sha256'},'control_rebind_attestation_scope')
    identity=attestation['socket_identity'];pid=attestation['peer_pid']
    need(type(identity)is list and len(identity)==2 and all(type(v)is int and 0<v<2**64 for v in identity)
      and type(pid)is int and 0<pid<2**22,'control_rebind_identity_invalid')
    need(all(type(attestation[k])is int and attestation[k]==1001 for k in('peer_uid','peer_gid','socket_uid'))
      and type(attestation['socket_mode'])is int and attestation['socket_mode']==0o600,'control_rebind_peer_refused')
    need(type(attestation['process_start_ticks'])is str and re.fullmatch('[1-9][0-9]{0,19}',attestation['process_start_ticks'])
      and type(attestation['executable_sha256'])is str and re.fullmatch('[a-f0-9]{64}',attestation['executable_sha256']),
      'control_rebind_process_unconfirmed')
    original={k:json.loads(v)for k,v in before.items()};out=copy.deepcopy(original)
    for name in original:need(type(original[name])is dict,'control_rebind_policy_invalid')
    legacy=out['legacy'];need('peer_pid'in legacy and 'socket_identity'in legacy,'control_rebind_policy_invalid')
    need(legacy['peer_pid']!=pid or legacy['socket_identity']!=identity,'control_rebind_already_applied')
    need(out['task'].get('legacy_policy_sha256')==sha(before['legacy']),'control_rebind_task_baseline_changed')
    deps=out['repair'].get('dependencies');need(type(deps)is dict,'control_rebind_policy_invalid')
    for kind in('legacy','task'):
        need(deps.get(POLICIES[kind])==sha(before[kind]),'control_rebind_dependency_baseline_changed')
    legacy.update(peer_pid=pid,socket_identity=copy.deepcopy(identity))
    result={'legacy':encode(legacy)}
    out['task']['legacy_policy_sha256']=sha(result['legacy']);result['task']=encode(out['task'])
    for kind in('legacy','task'):deps[POLICIES[kind]]=sha(result[kind])
    result['repair']=encode(out['repair'])
    # Restore the five permitted scalar references and compare the complete
    # objects, including unknown future authority/limit fields.
    check=copy.deepcopy(out)
    for k in('peer_pid','socket_identity'):check['legacy'][k]=original['legacy'][k]
    check['task']['legacy_policy_sha256']=original['task']['legacy_policy_sha256']
    for kind in('legacy','task'):check['repair']['dependencies'][POLICIES[kind]]=original['repair']['dependencies'][POLICIES[kind]]
    need(check==original,'control_rebind_authority_changed')
    return result
