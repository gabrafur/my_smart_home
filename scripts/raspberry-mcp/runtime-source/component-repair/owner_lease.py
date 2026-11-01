"""Recheck the existing owner grant from the immutable private Root profile.
No MCP-supplied path, authority, grant, renewal or automatically accepted identity.
Private operation IDs and approval hashes belong to that profile, not source.
"""
import json,re,time
from pathlib import Path
from source_writer import read,sha,need
def assert_active(lease,clock=time.time):
 need(type(lease)is dict and set(lease)=={'operation_id','receipt_sha256','rule_sha256','issued_at','expires_at'},'owner_lease_profile_invalid')
 op=lease['operation_id'];need(type(op)is str and re.fullmatch('[a-f0-9]{32}',op)is not None,'owner_lease_operation_invalid')
 need(all(type(lease[k])is str and re.fullmatch('[a-f0-9]{64}',lease[k])for k in('receipt_sha256','rule_sha256')),'owner_lease_hash_invalid')
 need(all(type(lease[k])is int for k in('issued_at','expires_at'))and 0<lease['expires_at']-lease['issued_at']<=604800,'owner_lease_duration_invalid')
 receipt=Path('/var/lib/raspberry-maintenance-plans')/('owner-root-sudo-seven-days-'+op)/'receipt.json'
 rule=Path('/etc/sudoers.d')/('zzzzzz-codex-owner-root-7d-'+op[:8])
 data=read(receipt,0,0o600,limit=4096);need(sha(data)==lease['receipt_sha256'],'owner_lease_receipt_changed');row=json.loads(data)
 need(row.get('operation_id')==op and row.get('rule_sha256')==lease['rule_sha256']and row.get('automatic_renewal')is False,'owner_lease_scope_changed')
 data=read(rule,0,0o440,limit=4096);info=rule.lstat();need(sha(data)==lease['rule_sha256']and [info.st_dev,info.st_ino]==row['rule_identity'],'owner_lease_rule_identity_changed')
 need(lease['issued_at']<=clock()<lease['expires_at'],'owner_root_lease_expired');return True
def observed_active(lease):
 try:return assert_active(lease)
 except (ValueError,OSError,KeyError,TypeError,json.JSONDecodeError):return False
