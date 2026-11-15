'use strict';
// Pure private data plane. Does not change the legacy notification reducer,
// public event receipts, subscription state or any execution authorization.
const {hash}=require('./notification_text.cjs');
const MAX_RECORDS=1024,MAX_EVENTS=256,MAX_BYTES=4*1024*1024,RETENTION_MS=7*86400*1000;
const HEX=/^[0-9a-f]{64}$/;
const PROJECTION_KEYS=new Set(['schema_version','source','object_id','observed_at','source_occurred_at','content_digest','text','redacted_fields','content_complete','complete_except_protected_secret_values','collection_error','content_bytes','mime_type','untrusted_source_text','execution_authority','coverage','revision','retained_at','legacy_ref']);
const REDACTION_REASONS=new Set(['private_key','credential_header','bearer_credential','credential_value','url_userinfo','signed_token','authentication_code','ping_credential']);
const copy=v=>JSON.parse(JSON.stringify(v));
function need(ok,why){if(!ok)throw Error(why);}
function at(value){const n=typeof value==='string'&&value.length<=40?Date.parse(value):NaN;need(Number.isFinite(n),'invalid_private_clock');return n;}
function validateProjection(p){
 need(p&&Object.keys(p).every(k=>PROJECTION_KEYS.has(k))&&p.schema_version===1&&typeof p.object_id==='string'&&HEX.test(p.object_id)&&typeof p.content_digest==='string'&&HEX.test(p.content_digest)&&
      p.source==='homeassistant.persistent_notification.private_text'&&p.collection_error===null&&
      p.content_complete===true&&p.complete_except_protected_secret_values===true&&
      p.mime_type==='text/plain'&&p.untrusted_source_text===true&&p.execution_authority===false&&
      p.text&&Object.keys(p.text).length===2&&typeof p.text.title==='string'&&typeof p.text.message==='string'&&
      p.content_digest===hash(JSON.stringify([p.text.title,p.text.message]))&&
      p.content_bytes===Buffer.byteLength(JSON.stringify(p.text),'utf8')&&
      Array.isArray(p.redacted_fields)&&p.redacted_fields.length<=16&&p.redacted_fields.every(r=>r&&Object.keys(r).length===3&&['title','message'].includes(r.field)&&REDACTION_REASONS.has(r.reason)&&Number.isSafeInteger(r.count)&&r.count>0&&r.count<=262144)&&
      JSON.stringify(p.coverage)===JSON.stringify(['exact_persistent_notification_frame','full_title_and_message_except_credentials',
       'no_allowlist_of_diagnostic_sentences','not_all_household_notification_channels','not_recovery_or_execution_proof']),
      'invalid_private_projection');
 at(p.observed_at);if(p.source_occurred_at!==null)at(p.source_occurred_at);
 return p;
}
function key(record){return record.object_id+':'+record.revision;}
class PrivateNoticeModel{
 constructor(saved=null){
  this.state=saved?copy(saved):{schema_version:1,source:'private_household_notice_records_v1',
   records:[],current:{},events:[],sequence:0,evicted_events:0,initialized:false,observed_at:null,
   collection_error:null,coverage:['persistent_notifications_only','private_content_not_webhook_payload',
     'source_event_is_not_assistant_execution','removal_is_not_recovery']};
  this.validate();
 }
 validate(){
  const s=this.state;
  need(s.schema_version===1&&s.source==='private_household_notice_records_v1'&&
       Array.isArray(s.records)&&s.records.length<=MAX_RECORDS&&Array.isArray(s.events)&&s.events.length<=MAX_EVENTS&&
       s.current&&typeof s.current==='object'&&!Array.isArray(s.current)&&
       Number.isSafeInteger(s.sequence)&&s.sequence>=0&&Number.isSafeInteger(s.evicted_events)&&s.evicted_events>=0&&
       typeof s.initialized==='boolean','invalid_private_state');
  const records=new Map();
  for(const record of s.records){
   validateProjection(record);
   need(HEX.test(record.revision)&&record.revision===hash(JSON.stringify(['private-notice-v1',record.object_id,record.source_occurred_at,record.content_digest]))&&
        !records.has(key(record))&&typeof record.retained_at==='string','private_record_binding_changed');
   at(record.retained_at);
   if(record.legacy_ref!==null)need(record.legacy_ref&&Object.keys(record.legacy_ref).length===2&&record.legacy_ref.object_id===record.object_id&&HEX.test(record.legacy_ref.revision),'legacy_association_changed');
   records.set(key(record),record);
  }
  need(Object.keys(s.current).length<=512,'private_current_limit');
  for(const [id,rev]of Object.entries(s.current))need(HEX.test(id)&&HEX.test(rev)&&records.has(id+':'+rev),'current_content_missing');
  need(s.sequence===s.evicted_events+s.events.length,'private_event_sequence_gap');
  for(let i=0;i<s.events.length;i++){
   const e=s.events[i];
   need(e&&HEX.test(e.object_id)&&HEX.test(e.revision)&&['added','updated','removed'].includes(e.phase)&&
        e.sequence===s.evicted_events+i+1&&e.event_id===hash(JSON.stringify([e.object_id,e.revision,e.phase,e.sequence]))&&
        e.recovery_proven===false,'private_event_changed');at(e.observed_at);
  }
  need(Buffer.byteLength(JSON.stringify(s))<=MAX_BYTES,'private_content_capacity_exceeded');
  return true;
 }
 applyCurrent(projections,legacyRefs,observedAt){
  const now=at(observedAt);need(Array.isArray(projections)&&projections.length<=512,'private_current_limit');
  need(Array.isArray(legacyRefs)&&legacyRefs.length<=512,'legacy_association_limit');
  const next=copy(this.state),byKey=new Map(next.records.map(r=>[key(r),r]));
  const refs=new Map();
  for(const r of legacyRefs){need(r&&HEX.test(r.object_id)&&HEX.test(r.revision)&&!refs.has(r.object_id),'invalid_legacy_association');refs.set(r.object_id,copy(r));}
  const current={};
  for(const raw of projections){
   const p=validateProjection(raw);need(!Object.hasOwn(current,p.object_id),'private_duplicate_identity');
   need(at(p.observed_at)<=now,'frame_observation_mismatch');
   const rev=hash(JSON.stringify(['private-notice-v1',p.object_id,p.source_occurred_at,p.content_digest]));
   current[p.object_id]=rev;
   const r={...copy(p),revision:rev,retained_at:new Date(now).toISOString(),legacy_ref:refs.get(p.object_id)||null};
   const existing=byKey.get(key(r));
   if(existing){
    // Re-observation is not a new receipt or a chance to overwrite content.
    need(existing.content_digest===r.content_digest&&existing.text.title===r.text.title&&existing.text.message===r.text.message,
      'immutable_private_revision_changed');
   }else byKey.set(key(r),r);
  }
  const changes=[];
  if(next.initialized){
   for(const[id,rev]of Object.entries(current))if(next.current[id]!==rev)changes.push({object_id:id,revision:rev,phase:Object.hasOwn(next.current,id)?'updated':'added'});
   for(const[id,rev]of Object.entries(next.current))if(!Object.hasOwn(current,id))changes.push({object_id:id,revision:rev,phase:'removed'});
  }
   for(const change of changes){
   next.sequence++;next.events.push({...change,event_id:hash(JSON.stringify([change.object_id,change.revision,change.phase,next.sequence])),
    sequence:next.sequence,observed_at:new Date(now).toISOString(),recovery_proven:false});
  }
  while(next.events.length>MAX_EVENTS){next.events.shift();next.evicted_events++;}
  // Retention applies only to this NEW derived private cache. It never changes
  // Node-RED history, HA notices or the existing event/receipt database.
  const required=new Set([...Object.entries(current).map(([id,r])=>id+':'+r),
   ...next.events.map(e=>e.object_id+':'+e.revision)]);
  next.records=[...byKey.values()].filter(r=>required.has(key(r))||now-at(r.retained_at)<=RETENTION_MS);
  next.current=current;next.initialized=true;next.observed_at=new Date(now).toISOString();next.collection_error=null;
  // Validate a disposable next state before committing anything in memory.
  const checked=new PrivateNoticeModel(next);this.state=checked.state;
  return changes.length;
 }
 snapshot(){return copy(this.state);}
 eventProjection(){
  const s=this.state;return {schema_version:1,source:'private_household_notice_event_references_v1',
   observed_at:s.observed_at,collection_error:s.collection_error,sequence:s.sequence,evicted_events:s.evicted_events,
   current:Object.entries(s.current).map(([object_id,revision])=>({object_id,revision})),
   events:copy(s.events),content_withheld:true,execution_authority:false,
   coverage:['opaque_references_only','read_exact_private_revision_via_authenticated_MCP',
    'not_existing_ha_notification_event_stream','not_assistant_execution_or_recovery']};
 }
 readExact(objectId,revision){
  need(HEX.test(objectId)&&HEX.test(revision),'invalid_private_reference');
  const row=this.state.records.find(r=>r.object_id===objectId&&r.revision===revision);
  return row?{...copy(row),current:this.state.current[objectId]===revision,recovery_proven:false}:
   {object_id:objectId,revision,state:'unknown',collection_error:'exact_revision_not_retained',recovery_proven:false};
 }
}
module.exports={PrivateNoticeModel,MAX_RECORDS,MAX_EVENTS,MAX_BYTES,RETENTION_MS};
