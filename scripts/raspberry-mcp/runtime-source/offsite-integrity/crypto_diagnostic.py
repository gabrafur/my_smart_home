"""Pure diagnostic projection for a future legitimate backup verification.
Does not authenticate, download, read credentials, extract or execute anything.
Historical receipts and consumed operations must never be rewritten/replayed.
"""
import json
REASONS=frozenset(('encrypted_input_limit','unexpected_outer_metadata','outer_member_invalid','outer_metadata_limit','multiple_encrypted_members','authenticated_format_required','plaintext_size_limit','plaintext_stream_limit','plaintext_length_unconfirmed','encrypted_member_missing','fixed_unprivileged_entrypoint_required','credential_input_limit','credential_input_invalid','authentication_incomplete'))
KINDS=frozenset(('ValueError','InvalidTag','ReadError','MemoryError','TimeoutError','OSError','EOFError','TypeError','AssertionError','RuntimeError'))
def pairs(items):
 result={}
 for key,value in items:
  if key in result:raise ValueError('duplicate_field')
  result[key]=value
 return result
def project(stdout,returncode):
 result={'authentication_proven':False,'reason':'authentication_reason_unavailable','raw_error_withheld':True,'automatic_retry':False}
 if type(returncode)is not int or returncode==0 or abs(returncode)>255:
  return {**result,'collection_error':'not_a_confirmed_failed_child'}
 result['returncode']=returncode
 if returncode<0:result['child_signal']={-9:'SIGKILL',-15:'SIGTERM',-14:'SIGALRM'}.get(returncode,'other_signal')
 if not isinstance(stdout,bytes)or not 0<len(stdout)<=2048:return {**result,'collection_error':'safe_child_envelope_unavailable'}
 try:
  row=json.loads(stdout,object_pairs_hook=pairs)
  if not isinstance(row,dict)or set(row)!={'authenticated','error','exception_kind','raw_error_withheld','automatic_retry'}or row['authenticated']is not False or row['raw_error_withheld']is not True or row['automatic_retry']is not False:
   raise ValueError('shape')
 except (ValueError,UnicodeError,TypeError):return {**result,'collection_error':'safe_child_envelope_invalid'}
 result['collection_error']=None;result['redacted_fields']=[]
 if isinstance(row['error'],str)and row['error']in REASONS:result['reason']=row['error']
 else:result['redacted_fields'].append({'field':'error','reason':'outside_reviewed_reason_vocabulary'})
 if isinstance(row['exception_kind'],str)and row['exception_kind']in KINDS:result['exception_kind']=row['exception_kind']
 else:result['redacted_fields'].append({'field':'exception_kind','reason':'outside_reviewed_exception_vocabulary'})
 return result
