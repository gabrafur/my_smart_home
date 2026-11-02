"""Pure provenance builder for the trusted Root reviewer, not an MCP operation.

The Root operator separately verifies public commit reachability and the reviewed
artifact. This function verifies byte identities; it grants no publication claim.
No paths, shell, credentials, runtime reads or writes are exposed here.
"""
import hashlib
import re

HEX40=re.compile('[a-f0-9]{40}')
HEX32=re.compile('[a-f0-9]{32}')

def source_entry(node_id,field,value,commit,blob,public_blob,review_id,reviewed_artifact):
    if not(type(node_id)is str and 0<len(node_id)<=128 and type(field)is str and 0<len(field)<=128
           and type(value)is str and type(public_blob)is bytes and len(public_blob)<=1048576
           and type(reviewed_artifact)is bytes and len(reviewed_artifact)<=1048576
           and HEX40.fullmatch(commit) and HEX40.fullmatch(blob) and HEX32.fullmatch(review_id)):
        raise ValueError('bounded_verified_public_inputs_required')
    identity=hashlib.sha1(b'blob '+str(len(public_blob)).encode()+b'\0'+public_blob).hexdigest()
    if identity!=blob or public_blob.decode('utf-8').rstrip()!=value:
        raise ValueError('public_source_value_does_not_match')
    import json
    field_sha=hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()).hexdigest()
    evidence={'git_commit':commit,'git_blob':blob,
              'public_artifact_sha256':hashlib.sha256(public_blob).hexdigest(),
              'reviewed_artifact_sha256':hashlib.sha256(reviewed_artifact).hexdigest(),
              'field_value_sha256':field_sha,'public_review_id':review_id,
              'public_source_review_passed':False}
    return {'entry':{'node_id':node_id,'field':field,'value_sha256':field_sha,
                     'value':value,'evidence':evidence},
            'normalization':'trailing_whitespace_only',
            'requires_root_public_commit_reachability_review':True}
