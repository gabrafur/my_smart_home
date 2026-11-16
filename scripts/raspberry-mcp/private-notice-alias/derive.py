"""Fixed five producer aliases preserve existing canonical notification identity.

A durable tombstone keeps alias ownership after recovery; HA frames cannot
resurrect or remove a claimed private incident. No free alias is accepted.
"""
import hashlib,json
BEFORE_SHA256='4bb5a1266ea8ba6b4eb14f31de0db2ea4ad46dd44709369b88ab6e4b755cd1f1'
PIN='notification_collector.cjs'
ROLES=('native_systemd_procmon','native_systemd_mcp_collection','native_systemd_external_heartbeat','native_docker_ai-bridge','observation_host_report')
ALIASES={'eva_private_'+role.replace('-','_'):'nodered_observabilidade_global_host_failure_'+role for role in ROLES}

def need(ok,reason):
 if not ok:raise ValueError(reason)
def sha(body):return hashlib.sha256(body).hexdigest()
def patch_collector(before):
 need(type(before) is bytes and sha(before)==BEFORE_SHA256,'collector_baseline_changed')
 after=before.decode()
 def replace(old,new):
  nonlocal after
  need(after.count(old)==1,'collector_anchor_not_unique');after=after.replace(old,new)
 replace('function readSpool(directory=SPOOL,producerUid=SPOOL_PRODUCER_UID){',
   'const SPOOL_ALIASES=Object.freeze('+json.dumps(ALIASES,separators=(',',':'))+');\nfunction readSpool(directory=SPOOL,producerUid=SPOOL_PRODUCER_UID){')
 replace("   if(!v||typeof v!=='object'||Array.isArray(v)||JSON.stringify(Object.keys(v).sort())!==JSON.stringify(['created_at','message','notification_id','schema_version','title'])||\n      v.schema_version!==1||v.notification_id!==id||typeof v.title!=='string'||!v.title.length||v.title.length>200||\n      typeof v.message!=='string'||!v.message.length||v.message.length>6000||typeof v.created_at!=='string'||!Number.isFinite(Date.parse(v.created_at)))throw Error('invalid_spool_entry');\n   found.set(id,{notification_id:id,title:v.title,message:v.message,created_at:new Date(Date.parse(v.created_at)).toISOString()});", """   const alias=SPOOL_ALIASES[id];
   const tombstone=Boolean(alias)&&v?.operation==='dismiss';
   const keys=tombstone?['created_at','message','notification_id','operation','schema_version','title']:['created_at','message','notification_id','schema_version','title'];
   if(!v||typeof v!=='object'||Array.isArray(v)||JSON.stringify(Object.keys(v).sort())!==JSON.stringify(keys)||
      v.schema_version!==1||v.notification_id!==id||typeof v.title!=='string'||!v.title.length||v.title.length>200||
      typeof v.message!=='string'||(!tombstone&&!v.message.length)||v.message.length>6000||typeof v.created_at!=='string'||!Number.isFinite(Date.parse(v.created_at)))throw Error('invalid_spool_entry');
   const canonical=alias??id;
   if(found.has(canonical))throw Error('spool_identity_collision');
   found.set(canonical,tombstone?null:{notification_id:canonical,title:v.title,message:v.message,created_at:new Date(Date.parse(v.created_at)).toISOString()});""")
 replace(" for(const[id,value]of current)if(JSON.stringify(applied.get(id))!==JSON.stringify(value))changed[id]=value;", " for(const[id,value]of current){if(value===null){if(applied.get(id)!==null)removed[id]={notification_id:id};}else if(JSON.stringify(applied.get(id))!==JSON.stringify(value))changed[id]=value;}")
 replace('let spoolApplied=new Map();','let spoolApplied=new Map(),spoolObserved=false;')
 replace("const current=spool.read();spool.status?.(null,current.size);", "const current=spool.read();spoolObserved=true;spool.status?.(null,[...current.values()].filter(v=>v!==null).length);")
 replace("spool.status?.('private_spool_unreadable',spoolApplied.size);return spoolApplied;", "spool.status?.('private_spool_unreadable',[...spoolApplied.values()].filter(v=>v!==null).length);if(!spoolObserved)throw Error('private_spool_unreadable');return spoolApplied;")
 replace("    const own=Object.fromEntries(Object.entries(event.notifications).filter(([id])=>!id.startsWith(SPOOL_PREFIX)));\n    if(event.type==='current'){spoolApplied=readSpoolOrKeep();event={...event,notifications:{...own,...Object.fromEntries(spoolApplied)}};}", """    // Reconcile fixed local ownership before accepting any HA frame. Claimed
    // aliases, including durable tombstones, always keep their canonical ID.
    if(event.type==='current')spoolApplied=readSpoolOrKeep();else syncSpool();
    const own=Object.fromEntries(Object.entries(event.notifications).filter(([id])=>!id.startsWith(SPOOL_PREFIX)&&!spoolApplied.has(id)));
    if(event.type==='current'){event={...event,notifications:{...own,...Object.fromEntries([...spoolApplied].filter(([,v])=>v!==null))}};}""")
 replace('module.exports={atomic,load,connect,readSpool,spoolFrames,SPOOL_PREFIX};','module.exports={atomic,load,connect,readSpool,spoolFrames,SPOOL_PREFIX,SPOOL_ALIASES};')
 raw=after.encode();need(len(raw)<=65536,'collector_exceeds_sealed_source_limit');return raw

def patch_policy(before,collector_before,collector_after):
 need(type(before) is bytes and 0<len(before)<=8192,'policy_bytes_required')
 pairs=json.loads(before,object_pairs_hook=list);need(len({k for k,_ in pairs})==len(pairs),'duplicate_policy_key')
 policy=json.loads(before);need(policy.get('enabled') is True and policy.get('revoked_at') is None,'policy_not_active')
 need(policy['source_hashes'].get(PIN)==sha(collector_before),'policy_pin_does_not_match_baseline')
 policy['source_hashes'][PIN]=sha(collector_after);text=before.decode();need(text.count(sha(collector_before))==1,'policy_pin_not_unique')
 after=text.replace(sha(collector_before),sha(collector_after)).encode();need(json.loads(after)==policy,'policy_changed_beyond_pin');return after

def derive(collector_before,policy_before):
 after=patch_collector(collector_before);return after,patch_policy(policy_before,collector_before,after)
