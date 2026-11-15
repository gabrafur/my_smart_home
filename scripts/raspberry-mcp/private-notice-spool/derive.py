"""Pure derivation for the private operational notice spool.

Technical notices meant only for the operating assistant used to need a Home
Assistant persistent notification as transport, which also showed them in the
owner's frontend. After the patch the notification collector completes the
frames of its existing subscription with closed JSON entries from a fixed
local spool. Those entries follow the same sanitized state, private capture
and event path, so the existing listing, content and event tools need no
change, while nothing is ever created in Home Assistant or sent to a phone.

Only the collector and the pin of its hash in the private-content policy
change. This module performs no file, service or permission operation. The
caller owns custody, compare-and-swap baselines, the collector restart and
installation.
"""
import hashlib
import json

BEFORE_SHA256 = '876e556e56a585da04990c7f6365ac89e85c3d0ab13d896c9bd39b9af09759f2'
PIN = 'notification_collector.cjs'

REPLACEMENTS = (
    (b"function connect({WebSocket,token,expectedUserHash,allowAdministrativeIdentity=false,state,publish,clock=Date.now,onTerminal=()=>{},onReconnect=()=>{},serviceProbe=null,privateCapture=null}){",
     b"""// Private operational spool. A fixed local producer leaves closed JSON notices
// here; they enter the same sanitized state, private capture and event path as
// HA persistent notifications but never exist in Home Assistant, so they reach
// neither its frontend nor a phone. The reserved identifier prefix belongs to
// the spool alone: an HA notification using it is ignored.
const SPOOL='/var/lib/raspberry-eva-notices/spool',SPOOL_PRODUCER_UID=1001,SPOOL_PREFIX='eva_private_';
const SPOOL_NAME=/^eva_private_[a-z0-9_]{1,64}\\.json$/,SPOOL_MAX=16,SPOOL_BYTES=16384;
function readSpool(directory=SPOOL,producerUid=SPOOL_PRODUCER_UID){
 const found=new Map();let info;
 try{info=fs.lstatSync(directory);}catch(e){if(e.code==='ENOENT')return found;throw e;}
 if(!info.isDirectory()||info.uid!==producerUid||(info.mode&0o002))throw Error('unsafe_spool');
 const names=fs.readdirSync(directory).filter(name=>SPOOL_NAME.test(name)).sort();
 if(names.length>SPOOL_MAX)throw Error('spool_limit');
 for(const name of names){
  let fd;
  try{fd=fs.openSync(path.join(directory,name),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);}
  catch(e){if(e.code==='ENOENT')continue;throw e;}
  try{
   const s=fs.fstatSync(fd);
   if(!s.isFile()||s.nlink!==1||s.uid!==producerUid||(s.mode&0o002)||s.size<=0||s.size>SPOOL_BYTES)throw Error('unsafe_spool_entry');
   const v=JSON.parse(fs.readFileSync(fd,'utf8')),id=name.slice(0,-5);
   if(!v||typeof v!=='object'||Array.isArray(v)||JSON.stringify(Object.keys(v).sort())!==JSON.stringify(['created_at','message','notification_id','schema_version','title'])||
      v.schema_version!==1||v.notification_id!==id||typeof v.title!=='string'||!v.title.length||v.title.length>200||
      typeof v.message!=='string'||!v.message.length||v.message.length>6000||typeof v.created_at!=='string'||!Number.isFinite(Date.parse(v.created_at)))throw Error('invalid_spool_entry');
   found.set(id,{notification_id:id,title:v.title,message:v.message,created_at:new Date(Date.parse(v.created_at)).toISOString()});
  }finally{fs.closeSync(fd);}
 }
 return found;
}
// Pure difference between the spool content already delivered and the current
// one, expressed as the frames the HA subscription itself would have sent.
function spoolFrames(applied,current){
 const changed={},removed={};
 for(const[id,value]of current)if(JSON.stringify(applied.get(id))!==JSON.stringify(value))changed[id]=value;
 for(const id of applied.keys())if(!current.has(id))removed[id]={notification_id:id};
 const frames=[];
 if(Object.keys(changed).length)frames.push({type:'updated',notifications:changed});
 if(Object.keys(removed).length)frames.push({type:'removed',notifications:removed});
 return frames;
}
function connect({WebSocket,token,expectedUserHash,allowAdministrativeIdentity=false,state,publish,clock=Date.now,onTerminal=()=>{},onReconnect=()=>{},serviceProbe=null,privateCapture=null,spool=null}){"""),
    (b" let ended=false,authenticated=false,roleRequested=false,identityVerified=false,subscribed=false,lastPing=0;\n",
     b""" let ended=false,authenticated=false,roleRequested=false,identityVerified=false,subscribed=false,lastPing=0;
 // Spool content last delivered on this connection; a failed read keeps it, so
 // an unreadable spool never looks like every private notice being withdrawn.
 let spoolApplied=new Map();
 const readSpoolOrKeep=()=>{if(!spool)return new Map();try{const current=spool.read();spool.status?.(null,current.size);return current;}catch{spool.status?.('private_spool_unreadable',spoolApplied.size);return spoolApplied;}};
 const deliver=(event,received)=>{const observed=clock();state.apply(event,observed,received);try{privateCapture?.observe(event,[...state.current.values()],new Date(observed).toISOString());}catch{privateCapture?.collectionFailure();}};
 const syncSpool=()=>{if(!spool)return;const current=readSpoolOrKeep();if(current===spoolApplied)return;
  for(const frame of spoolFrames(spoolApplied,current))deliver(frame,clock());spoolApplied=current;};
"""),
    (b"  if(subscribed){lastPing=clock();ws.ping();try{publish()}catch{finish('storage_failed',true)}}\n",
     b"  if(subscribed){lastPing=clock();ws.ping();try{syncSpool();}catch{finish('invalid_response',true);return;}try{publish()}catch{finish('storage_failed',true)}}\n"),
    (b"  else if(msg.type==='event'&&msg.id===2){if(!identityVerified||!subscribed&&msg.event?.type!=='current')throw Error('invalid_response');const observed=clock();state.apply(msg.event,observed,received);try{privateCapture?.observe(msg.event,[...state.current.values()],new Date(observed).toISOString());}catch{privateCapture?.collectionFailure();}const first=!subscribed;",
     b"""  else if(msg.type==='event'&&msg.id===2){if(!identityVerified||!subscribed&&msg.event?.type!=='current')throw Error('invalid_response');
   let event=msg.event;
   if(spool&&event?.notifications&&typeof event.notifications==='object'&&!Array.isArray(event.notifications)){
    // The reserved prefix is spool-only; a full HA frame is completed with the
    // spool so it cannot withdraw notices that HA never knew about.
    const own=Object.fromEntries(Object.entries(event.notifications).filter(([id])=>!id.startsWith(SPOOL_PREFIX)));
    if(event.type==='current'){spoolApplied=readSpoolOrKeep();event={...event,notifications:{...own,...Object.fromEntries(spoolApplied)}};}
    else event={...event,notifications:own};
   }
   deliver(event,received);const first=!subscribed;"""),
    (b" const start=()=>{connection=connect({WebSocket,token,expectedUserHash:identity.user_id_sha256,allowAdministrativeIdentity:identity.role==='approved_existing_administrator',state,publish,serviceProbe,privateCapture,",
     b""" let spoolState={state:'unknown',collection_error:'not_yet_observed',current_entries:0};
 const spool={read:()=>readSpool(),status:(error,count)=>{const next={state:error?'unknown':'observed',collection_error:error,current_entries:count};
  if(JSON.stringify(next)===JSON.stringify(spoolState))return;spoolState=next;
  try{atomic(STATE+'/public','private-spool.json',{schema_version:1,source:'fixed_private_operational_spool_v1',observed_at:new Date().toISOString(),...next,
   coverage:['local_producer_notices_only','never_created_in_home_assistant','not_phone_delivery','delivery_requires_active_HA_subscription']},0o640);}catch{/* Status is advisory; notices stay independent. */}}};
 const start=()=>{connection=connect({WebSocket,token,expectedUserHash:identity.user_id_sha256,allowAdministrativeIdentity:identity.role==='approved_existing_administrator',state,publish,serviceProbe,privateCapture,spool,"""),
    (b"module.exports={atomic,load,connect};",
     b"module.exports={atomic,load,connect,readSpool,spoolFrames,SPOOL_PREFIX};"),
)


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def sha(body):
    return hashlib.sha256(body).hexdigest()


def patch_collector(before):
    need(type(before) is bytes and sha(before) == BEFORE_SHA256, 'collector_baseline_changed')
    after = before
    for old, new in REPLACEMENTS:
        need(after.count(old) == 1, 'collector_anchor_not_unique')
        after = after.replace(old, new)
    need(len(after) <= 65536, 'collector_exceeds_sealed_source_limit')
    return after


def patch_policy(before, collector_before, collector_after):
    """Move only the collector pin; every other field survives byte-for-byte in meaning."""
    need(type(before) is bytes and 0 < len(before) <= 8192, 'policy_bytes_required')
    pairs = json.loads(before, object_pairs_hook=list)
    need(len({k for k, _ in pairs}) == len(pairs), 'duplicate_policy_key')
    policy = json.loads(before)
    need(policy.get('enabled') is True and policy.get('revoked_at') is None, 'policy_not_active')
    need(policy['source_hashes'].get(PIN) == sha(collector_before), 'policy_pin_does_not_match_baseline')
    policy['source_hashes'][PIN] = sha(collector_after)
    text = before.decode()
    need(text.count(sha(collector_before)) == 1, 'policy_pin_not_unique')
    after = text.replace(sha(collector_before), sha(collector_after)).encode()
    need(json.loads(after) == policy, 'policy_changed_beyond_pin')
    return after


def derive(collector_before, policy_before):
    collector_after = patch_collector(collector_before)
    return collector_after, patch_policy(policy_before, collector_before, collector_after)
