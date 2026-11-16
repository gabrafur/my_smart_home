"""Pure derivation: make maintenance gateway refusals diagnosable without leaking data.

Every gateway exception became the same ``native_enrollment_or_operation_unconfirmed``,
so a lock-identity drift, a busy core database and a missing operation looked alike,
and an ID that was never created could not be told apart from an uncertain one.

1. ``unknown(error)`` adds ``refusal_code``: the static ``ValueError`` code when it is a
   plain identifier (all gateway/core/native refusals are fixed literals), otherwise the
   exception type name. Messages, paths and values are never echoed.
2. ``maintenance_read view=operation`` returns ``state: absent`` when the core has no
   row and no artifact-renewal journal exists for that ID
   (``operation_unknown_observe_only``), so a caller can confirm absence before retrying.

Only owner-policy core_sources.gateway.py pins the gateway source.
"""
import hashlib
import json

UNKNOWN_OLD = "def unknown():\n"
UNKNOWN_NEW = "def unknown(error=None):\n"
UNKNOWN_RETURN_OLD = ("            'coverage':['no_implicit_admission_or_retry','observe_existing_receipts_if_dispatch_may_have_started'],"
                      "'automatic_retry':False}\n")
UNKNOWN_RETURN_NEW = ("            'coverage':['no_implicit_admission_or_retry','observe_existing_receipts_if_dispatch_may_have_started'],"
                      "'automatic_retry':False,'refusal_code':refusal_code(error)}\n")
HELPER_ANCHOR = "def unknown(error=None):\n"
HELPER = '''def refusal_code(error):
    # Static refusal literal or exception type only; never a message, path or value.
    if error is None:return None
    if isinstance(error,ValueError)and len(error.args)==1 and type(error.args[0])is str and re.fullmatch('[a-z][a-z0-9_]{2,63}',error.args[0]):
        return error.args[0]
    name=type(error).__name__
    return name if re.fullmatch('[A-Za-z][A-Za-z0-9]{2,39}',name)else 'unclassified'


'''
MAIN_OLD = ("    except Exception:\n"
            "        try:os.write(1,json.dumps(unknown(),separators=(',',':')).encode()+b'\\n')\n")
MAIN_NEW = ("    except Exception as error:\n"
            "        try:os.write(1,json.dumps(unknown(error),separators=(',',':')).encode()+b'\\n')\n")
OBSERVE_OLD = "        return runtime.observe_operation(a['operation_id'])\n"
OBSERVE_NEW = ("        try:return runtime.observe_operation(a['operation_id'])\n"
               "        except ValueError as error:\n"
               "            if error.args!=('operation_unknown_observe_only',):raise\n"
               "            return {'source':'closed_registered_maintenance_gateway','operation_id':a['operation_id'],'state':'absent',\n"
               "                    'observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'age_seconds':0,'collection_error':None,\n"
               "                    'coverage':['no_core_row_and_no_artifact_renewal_journal_for_this_id','not_proof_of_absence_of_other_ids'],'automatic_retry':False}\n")


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def swap(body, old, new, reason):
    need(body.count(old) == 1 and body.count(new) == 0, reason)
    return body.replace(old, new)


def derive(gateway, owner_policy):
    need(b'def refusal_code' not in gateway, 'gateway_already_patched')
    need(b'import re' in gateway and b'import datetime' in gateway, 'gateway_imports')
    out = swap(gateway, UNKNOWN_OLD.encode(), UNKNOWN_NEW.encode(), 'unknown_anchor')
    out = swap(out, UNKNOWN_RETURN_OLD.encode(), UNKNOWN_RETURN_NEW.encode(), 'unknown_return_anchor')
    out = swap(out, HELPER_ANCHOR.encode(), HELPER.encode() + HELPER_ANCHOR.encode(), 'helper_anchor')
    out = swap(out, MAIN_OLD.encode(), MAIN_NEW.encode(), 'main_anchor')
    out = swap(out, OBSERVE_OLD.encode(), OBSERVE_NEW.encode(), 'observe_anchor')
    owner = swap(owner_policy, sha(gateway).encode(), sha(out).encode(), 'owner_gateway_pin')
    a, b = json.loads(owner), json.loads(owner_policy)
    b['core_sources']['gateway.py'] = sha(out)
    need(a == b, 'owner_policy_changed_beyond_pin')
    return out, owner
