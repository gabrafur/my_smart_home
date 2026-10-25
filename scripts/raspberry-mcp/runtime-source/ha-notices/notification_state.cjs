// Deterministic reducer; only sanitized values survive the current input frame.
const {createHash}=require('node:crypto');
const {sanitize}=require('./notification_view.cjs');
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const MAX_NOTICES=512,MAX_EVENTS=256;
const revision=n=>digest([n.id,n.created_or_updated_at,n.category,n.summary,n.category_basis]);
const ERRORS=new Set(['starting','connection_failed','connection_closed','auth_failed','credential_role_refused','subscription_refused','invalid_response','pong_timeout','storage_failed','resource_budget_exceeded']);
class NotificationState {
 constructor(saved=null){
  this.current=new Map();this.events=[];this.sequence=0;this.dropped=0;this.initialized=false;
  this.error='starting';this.connected=false;this.lastPong=null;this.lastEvent=null;this.latencyMs=null;
  if(saved){
   if(saved.schema_version!==1||!Array.isArray(saved.notifications)||saved.notifications.length>MAX_NOTICES||!Array.isArray(saved.events)||saved.events.length>MAX_EVENTS||!Number.isSafeInteger(saved.sequence)||saved.sequence<0)throw Error('invalid_cache');
   for(const n of saved.notifications){
    if(!n||!/^[a-f0-9]{64}$/.test(n.id)||typeof n.revision!=='string'||n.revision!==revision(n)||n.content_withheld!==true)throw Error('invalid_cache');
    this.current.set(n.id,n);
   }
   for(const e of saved.events){if(!e||!/^[a-f0-9]{64}$/.test(e.id)||!['added','updated','removed'].includes(e.phase)||!Number.isSafeInteger(e.sequence))throw Error('invalid_cache');}
   this.events=saved.events;this.sequence=saved.sequence;this.dropped=saved.dropped||0;this.initialized=true;
  }
 }
 failure(reason){this.connected=false;this.error=ERRORS.has(reason)?reason:'invalid_response';}
 pong(now){this.lastPong=now;}
 apply(event,now,receivedAt=now){
  if(!Number.isFinite(now)||!Number.isFinite(receivedAt)||receivedAt>now||!event||!['current','added','updated','removed'].includes(event.type)||!event.notifications||Array.isArray(event.notifications)||typeof event.notifications!=='object'||Object.keys(event.notifications).length>MAX_NOTICES)throw Error('invalid_response');
  const candidate=event.type==='current'?new Map():new Map(this.current), observedAt=new Date(now).toISOString();
  for(const [rawId,value] of Object.entries(event.notifications)){
   if(!value||value.notification_id!==rawId)throw Error('invalid_response');
   const clean=sanitize(value,observedAt);if(!clean)throw Error('invalid_response');
   if(event.type==='removed')candidate.delete(clean.id);
   else candidate.set(clean.id,{...clean,revision:revision(clean)});
  }
  if(candidate.size>MAX_NOTICES)throw Error('notification_limit');
  const changes=[];
  if(this.initialized){
   for(const [id,notice] of candidate){const old=this.current.get(id);if(!old||old.revision!==notice.revision)changes.push({object_id:id,revision:notice.revision,phase:old?'updated':'added'});}
   for(const [id,notice] of this.current)if(!candidate.has(id))changes.push({object_id:id,revision:digest([notice.revision,'removed']),phase:'removed'});
  }
  // Initial current state is a baseline, never a recovery or backlog notification.
  for(const change of changes){
   this.sequence++;const id=digest([change.object_id,change.revision,change.phase]);
   this.events.push({...change,id,sequence:this.sequence,observed_at:observedAt,source:'ha_persistent_notification',topic:'ha_notification',recovery_proven:false});
  }
  while(this.events.length>MAX_EVENTS){this.events.shift();this.dropped++;}
  this.current=candidate;this.initialized=true;this.connected=true;this.error=null;
  this.lastEvent=now;this.lastPong=now;this.latencyMs=now-receivedAt;
  return changes.length;
 }
 snapshot(now){const output={schema_version:1,source:'HA WebSocket persistent_notification/subscribe',observed_at:new Date(now).toISOString(),
  collection_error:this.error,connection_state:this.connected?'subscribed':'unknown',last_transport_confirmation_at:this.lastPong===null?null:new Date(this.lastPong).toISOString(),
  last_source_event_received_at:this.lastEvent===null?null:new Date(this.lastEvent).toISOString(),last_processing_latency_ms:this.latencyMs,
  coverage:['persistent_notifications_only','no_raw_title_or_body','not_phone_delivery','removal_is_not_recovery','processing_latency_not_end_to_end_latency'],
  notifications:[...this.current.values()].sort((a,b)=>a.id.localeCompare(b.id)),events:this.events,sequence:this.sequence,dropped:this.dropped};
  output.coverage.push('sanitized_content_tokens_only_no_raw_title_or_body');
  output.diagnostic_content_enabled=true;output.content_budget_omissions=0;
  const pending=output.notifications.map(n=>n.diagnostics);
  output.notifications=output.notifications.map(({diagnostics,...n})=>({...n,diagnostic_content_state:diagnostics?'budget_exhausted':'not_yet_observed'}));
  let remaining=524288-4096-Buffer.byteLength(JSON.stringify(output));
  for(let i=0;i<output.notifications.length;i++){
   if(!pending[i])continue;
   const before=output.notifications[i],after={...before,diagnostics:pending[i]};delete after.diagnostic_content_state;
   const extra=Buffer.byteLength(JSON.stringify(after))-Buffer.byteLength(JSON.stringify(before));
   if(extra<=remaining){output.notifications[i]=after;remaining-=extra;}else output.content_budget_omissions++;
  }
  return output;
 }

}
module.exports={NotificationState,revision,ERRORS};
