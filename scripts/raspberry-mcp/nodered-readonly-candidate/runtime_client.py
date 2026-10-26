"""Fixed local readonly Node-RED resources; no path, command or mutation input."""
import datetime,json,os,re,socket,stat,struct
from pathlib import Path
SOCKET=Path('/run/raspberry-nodered-diagnostics.sock')
def request(q):
 try:
  s=SOCKET.lstat()
  if not stat.S_ISSOCK(s.st_mode)or s.st_uid!=1001 or stat.S_IMODE(s.st_mode)!=0o600:raise ValueError('socket_identity_invalid')
  with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)as c:
   c.settimeout(32);c.connect(str(SOCKET));_,uid,_=struct.unpack('3i',c.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
   # systemd creates the listener; SocketUser changes DAC, not SO_PEERCRED.
   # net.Server.listen(fd=3) renews listener credentials while warm.
   if uid not in (0,1001):raise ValueError('peer_identity_invalid')
   c.sendall((json.dumps(q,separators=(',',':'))+'\n').encode());out=bytearray()
   while b'\n'not in out:
    b=c.recv(4096)
    if not b or len(out)+len(b)>65536:raise ValueError('response_limit')
    out.extend(b)
   if out.count(b'\n')!=1 or not out.endswith(b'\n'):raise ValueError('response_framing')
   v=json.loads(out)
   if type(v)is dict and v.get('ok')is False:
    allowed={'virtual_nodered_resource_unavailable','virtual_nodered_snapshot_unavailable','virtual_nodered_resource_budget_exhausted','virtual_nodered_document_limit_exceeded','runtime_collection_unavailable','collection_cooldown','read_session_revocation_unconfirmed','sidecar_busy','request_refused','integration_collection_unavailable'}
    reason=v.get('error')if v.get('error')in allowed else'collection_unavailable'
    raise ValueError(reason)
   if type(v)is not dict or v.get('ok')is not True or type(v.get('result'))is not dict:raise ValueError('collection_unavailable')
   return v['result']
 except Exception as error:
  allowed={'socket_identity_invalid','peer_identity_invalid','response_limit','response_framing','collection_unavailable','virtual_nodered_resource_unavailable','virtual_nodered_snapshot_unavailable','virtual_nodered_resource_budget_exhausted','virtual_nodered_document_limit_exceeded','runtime_collection_unavailable','collection_cooldown','read_session_revocation_unconfirmed','sidecar_busy','request_refused','integration_collection_unavailable'}
  reason=str(error)if type(error)is ValueError and str(error)in allowed else'socket_timeout'if isinstance(error,TimeoutError)else'transport_unavailable'
  return {'reason_code':reason,'source':'fixed_NodeRED_readonly_socket','observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'collection_error':'NodeRED_runtime_collection_unavailable','state':'unknown','coverage':['collection_failed_not_absence_or_recovery'],'automatic_retry':False}
def files():return request({'op':'files','host':'raspberry','offset':0})
def read(args):
 if set(args)!={'host','file_id','offset'}or args['host']!='raspberry'or type(args['file_id'])is not str or re.fullmatch('[a-f0-9]{32}',args['file_id'])is None or type(args['offset'])is not int or not 0<=args['offset']<=262144:raise ValueError('invalid_parameters')
 return request({'op':'read',**args})
def capabilities():return {'implemented':True,'read_only':True,'host':'raspberry','discovery':{'tool':'project_files','category':'nodered','offset':0},'read_tool':'project_read','scope':['all_loaded_NodeRED_flow_and_node_inventory','connections','reviewed_public_matching_sanitized_source_and_parameters','fixed_Kia_integration_update_receipts_and_sensor'],'coverage_partial':['unreviewed_private_parameters_and_source_withheld','no_context_history_raw_logs_or_credentials','not_deployment_or_functional_acceptance'],'current_collection':'on_explicit_discovery_or_read_only_not_catalog_advertisement','new_write_operations':0}
