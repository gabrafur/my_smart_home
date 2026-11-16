"""Pure derivation: close an own client rollback whose lifecycle lost only its start confirmation.

The client lifecycle marks an operation ``uncertain_observe_only`` if any exception
happens after the files were committed, including while it confirms the service
starts. For installs, a Root post-start observation can close that state. For
rollbacks nothing could, so an own rollback that restored every source and reference
stayed pending forever and blocked every later maintenance operation.

This derivation changes the installed native_binding.py in three exact places:

1. ``PS_DIAGNOSTIC_COMMON`` also allowlists the remaining static ValueError codes of the
   start-confirmation path (lock re-verification and sealed reads), so the next
   failure records its real reason instead of ``diagnostic_reason_not_allowlisted``.
2. ``client_lifecycle_status`` accepts an immutable Root rollback-completion proof for
   a ``rollback`` lifecycle that is uncertain only in a start phase. The proof binds
   the exact lifecycle, file and reference receipt bytes, which must already say
   ``own_rollback_configuration_only`` / ``references_restored``. The live afterimages
   and active services are checked once by the Root operator that writes the proof.
3. ``ClientNativeIO.unresolved`` treats such a proven rollback as resolved.

Then it moves only the hashes that pin native_binding.py (owner policy, install
enrollment, package enrollment approval, catalogue manifest, bootstrap manifest rows
and digest). The caller owns custody, CAS and installation.
"""
import hashlib
import json

NAMES = ('native_binding', 'owner_policy', 'install_enrollment', 'package_enrollment_approval',
         'catalogue_manifest', 'bootstrap_manifest')

DIAG_OLD = ("PS_DIAGNOSTIC_COMMON=frozenset(('client_native_command_unconfirmed','client_show_schema',"
            "'client_query_binary_changed','standing_or_global_revocation_closed','scope_revoke_fence_closed'))")
DIAG_NEW = ("PS_DIAGNOSTIC_COMMON=frozenset(('client_native_command_unconfirmed','client_show_schema',"
            "'client_query_binary_changed','standing_or_global_revocation_closed','scope_revoke_fence_closed',"
            "'held_lock_path_changed','shared_lock_not_held','held_lock_binding_changed',"
            "'sealed_source_changed','sealed_source_refused','client_command_refused'))")

UNRESOLVED_OLD = "            proof=rr_terminal_proof(row.get('operation_id'))or ps_terminal_cutover(row.get('operation_id'))"
UNRESOLVED_NEW = ("            proof=rr_terminal_proof(row.get('operation_id'))or ps_terminal_cutover(row.get('operation_id'))"
                  "or rb_completion_proof(row.get('operation_id'))")

STATUS_OLD = ("        completed=ps_native_observe(op,held_locks)\n"
              "        if completed is not None:return completed\n")
STATUS_NEW = ("        completed=ps_native_observe(op,held_locks)\n"
              "        if completed is not None:return completed\n"
              "        rollback=rb_completion_status(op,row)\n"
              "        if rollback is not None:return rollback\n")

FUNCTIONS_ANCHOR = "def client_lifecycle_status(op,held_locks=None):"
FUNCTIONS = '''RB_SOURCE='Root_observed_own_rollback_completion_v1'
RB_START_PHASES=frozenset(('events_start_pending','socket_start_pending','tunnel_start_pending'))
RB_SERVICES={'events':'active','socket':'active','tunnel':'active'}

def rb_completion_proof(op):
    """Immutable Root evidence for an own rollback uncertain only in a start phase."""
    try:
        lc_need(type(op) is str and re.fullmatch('[a-f0-9]{32}',op),'rollback_completion_operation')
        base=STATE/'client-lifecycle'
        try:proof_raw=read_sealed(base/'rollback-completions'/(op+'.json'),16384)
        except FileNotFoundError:return None
        proof=json.loads(proof_raw)
        keys={'source','operation_id','own_operation_id','package_id','lifecycle_sha256','file_sha256','references_sha256',
              'live_sources','live_references','services','worker_sha256','observed_at'}
        lc_need(type(proof) is dict and set(proof)==keys and proof['source']==RB_SOURCE and proof['operation_id']==op,'rollback_completion_schema')
        life_raw=read_sealed(base/'operations'/(op+'.json'),3145728)
        file_raw=read_sealed(STATE/'receipts'/(op+'.json'),3145728)
        refs_raw=read_sealed(base/'source-refs'/(op+'.json'),3145728)
        lc_need(hashlib.sha256(life_raw).hexdigest()==proof['lifecycle_sha256'] and hashlib.sha256(file_raw).hexdigest()==proof['file_sha256']
                and hashlib.sha256(refs_raw).hexdigest()==proof['references_sha256'],'rollback_completion_evidence_changed')
        life,file,refs=json.loads(life_raw),json.loads(file_raw),json.loads(refs_raw)
        lc_need(life.get('state')=='uncertain_observe_only' and life.get('verb')=='rollback' and life.get('phase') in RB_START_PHASES
                and life.get('operation_id')==op and life.get('own_operation_id')==proof['own_operation_id']
                and life.get('package_id')==proof['package_id'] and life.get('services_household_touched') is False,'rollback_completion_lifecycle')
        lc_need(file.get('state')=='own_rollback_configuration_only' and file.get('operation_id')==op
                and file.get('own_operation_id')==proof['own_operation_id'] and file.get('package_id')==proof['package_id']
                and file.get('own_sources_restored') is True and file.get('activation_created_by_install') is False
                and type(file.get('rollback_after_hashes')) is dict and file['rollback_after_hashes']==proof['live_sources']
                and life.get('file_receipt_sha256')==lc_hash({k:v for k,v in file.items() if k!='before'}),'rollback_completion_file')
        lc_need(refs.get('state')=='references_restored' and refs.get('restore') is True and refs.get('operation_id')==op
                and refs.get('own_operation_id')==proof['own_operation_id'] and type(refs.get('after_hashes')) is dict
                and refs['after_hashes']==proof['live_references']
                and life.get('reference_receipt_sha256')==lc_hash({k:v for k,v in refs.items() if k!='before'}),'rollback_completion_references')
        lc_need(proof['services']==RB_SERVICES and proof['worker_sha256']==file['rollback_after_hashes'].get('client_events_worker')
                and type(proof['observed_at']) in (int,float) and math.isfinite(proof['observed_at']),'rollback_completion_observation')
        return proof
    except (OSError,ValueError,KeyError,TypeError):return None

def rb_completion_status(op,row):
    if row.get('state')!='uncertain_observe_only' or row.get('verb')!='rollback':return None
    proof=rb_completion_proof(op)
    if proof is None:return None
    value=client_public_receipt(row)
    value.update(state='own_rollback_configuration_only',original_lifecycle_state='uncertain_observe_only',
                 own_sources_restored=True,rollback_after_hashes=dict(proof['live_sources']),
                 derived_status_source=RB_SOURCE,rollback_completion={k:proof[k] for k in ('source','observed_at','services')},
                 original_command_outcome='unknown_not_replayed',automatic_retry=False,functional_recovery_proven=False)
    return value

'''


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def canonical(v):
    return json.dumps(v, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def swap(body, old, new, reason):
    need(body.count(old) == 1 and body.count(new) == 0, reason)
    return body.replace(old, new)


def patch(source):
    need(b'rb_completion_proof' not in source, 'native_binding_already_patched')
    out = swap(source, DIAG_OLD.encode(), DIAG_NEW.encode(), 'diagnostic_anchor')
    out = swap(out, UNRESOLVED_OLD.encode(), UNRESOLVED_NEW.encode(), 'unresolved_anchor')
    out = swap(out, STATUS_OLD.encode(), STATUS_NEW.encode(), 'status_anchor')
    out = swap(out, FUNCTIONS_ANCHOR.encode(), FUNCTIONS.encode() + FUNCTIONS_ANCHOR.encode(), 'functions_anchor')
    return out


def repin(before, source_key, after_source):
    """Move every pin of one installer source and the dependent bootstrap rows/digest."""
    after = {source_key: after_source}
    old, new = sha(before[source_key]), sha(after_source)
    for name in ('owner_policy', 'install_enrollment', 'package_enrollment_approval', 'catalogue_manifest'):
        after[name] = swap(before[name], old.encode(), new.encode(), name + '_source_pin')
    boot = before['bootstrap_manifest']
    for name in (source_key, 'install_enrollment', 'package_enrollment_approval', 'catalogue_manifest'):
        o, n = sha(before[name]), sha(after[name])
        if boot.count(o.encode()) == 1:
            boot = swap(boot, o.encode(), n.encode(), 'bootstrap_row_' + name)
        else:
            need(name != source_key, 'bootstrap_source_row')
    manifest = json.loads(boot)
    old_digest = json.loads(before['bootstrap_manifest'])['manifest_sha256']
    new_digest = sha(canonical({'files': manifest['files'], 'expires_at': manifest['expires_at']}))
    after['bootstrap_manifest'] = swap(boot, old_digest.encode(), new_digest.encode(), 'bootstrap_digest')
    for name in NAMES[1:]:
        need(set(json.loads(after[name])) == set(json.loads(before[name])), name + '_shape_changed')
    return after


def derive(before):
    need(type(before) is dict and set(before) == set(NAMES) and all(type(v) is bytes for v in before.values()), 'six_inputs')
    return repin(before, 'native_binding', patch(before['native_binding']))
