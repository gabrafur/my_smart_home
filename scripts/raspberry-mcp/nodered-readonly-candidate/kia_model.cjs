'use strict';
// Pure fixed-source projection. No I/O, clock reads, imports or exported raw values.
const SOURCES=['sensor','safe_update','worker_result','merge','promotion','promotion_public','pending','schedule'];
const REASONS=new Set(['connect_timeout','transport_timeout','dns_resolution_failed','connection_failed','tls_verification_failed','audit_failed_unclassified','invalid_request','working_tree_changed','main_behind_remote','host_update_in_progress','git_publication_failed']);
const RESULTS={sensor:['unknown','compatible','conflict','applying','applied','rollback','failed'],safe_update:['unknown','compatible','conflict','applying','applied','rollback','failed','ready'],worker_result:['unknown','running','compatible','conflict','applied','rollback','failed','deferred','unavailable'],merge:['waiting','running','success','failed'],promotion:['deferred','applying','runtime_applied','applied_pending_git','main_published','completed','failed'],promotion_public:['deferred','applying','runtime_applied','applied_pending_git','main_published','completed','failed']};
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const version=x=>typeof x==='string'&&/^v?\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][A-Za-z0-9.-]{1,64})?$/.test(x)?x:null;
const stamp=x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x.slice(0,19)+'Z').toISOString().slice(0,19)===x.slice(0,19)?x:null;
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x)?x:null;
const id=x=>typeof x==='string'&&/^\d{8}T\d{6}Z-\d{1,12}$/.test(x)?x:null;
const equalVersion=(a,b)=>a&&b?a.replace(/^v/,'')===b.replace(/^v/,''):null;
function parseLine(x){
 if(typeof x!=='string'||x.length>2048||/[\r\n\0]/.test(x))return null;
 const tokens=x.trim().split(/ +/);if(tokens.shift()!=='kia-uvo-update')return null;
 const out={};
 for(const token of tokens){const match=/^([a-z_]+)=([^ ]+)$/.exec(token);if(!match||Object.hasOwn(out,match[1]))return null;out[match[1]]=match[2];}
 return out;
}
function row(name,envelope,now){
 const out={source:name,observed_at:null,source_updated_at:null,age_seconds:null,state:'missing',collection_error:null,stage:name,result:null,reason_code:null,request_id:null,mode:null,installed_version:null,target_version:null,coverage:['fixed_allowlist_no_raw_messages_or_vehicle_values']};
 if(envelope==null)return out;
 if(!record(envelope))return {...out,state:'unknown',collection_error:'invalid_schema'};
 out.observed_at=stamp(envelope.observed_at);
 if(envelope.collection_error!=null)return {...out,state:'unknown',collection_error:'collection_failed'};
 if(!out.observed_at||Date.parse(out.observed_at)>now*1000)return {...out,state:'unknown',collection_error:'invalid_collection_time'};
 if(envelope.data==null)return out;
 let d=name==='worker_result'?parseLine(envelope.data):envelope.data;
 if(!record(d))return {...out,state:'unknown',collection_error:'invalid_schema'};
 if(name==='pending'){
  const keys=['audit_requested','audit_processing','audit_followup','merge_requested','merge_processing'];
  if(!keys.every(k=>typeof d[k]==='boolean'))return {...out,state:'unknown',collection_error:'invalid_schema'};
  out.pending=Object.fromEntries(keys.map(k=>[k,d[k]]));out.result=keys.some(k=>d[k])?'pending':'idle';out.source_updated_at=out.observed_at;
 }else if(name==='schedule'){
  if(d.crontab!=='00 03 * * *'||!['America/Sao_Paulo','Etc/UTC','UTC'].includes(d.timezone)||typeof d.loaded!=='boolean'||typeof d.authorizes_install!=='boolean')return {...out,state:'unknown',collection_error:'invalid_schema'};
  out.schedule={crontab:d.crontab,timezone:d.timezone,loaded:d.loaded,authorizes_install:d.authorizes_install};out.result=d.loaded?'loaded':'not_loaded';out.source_updated_at=out.observed_at;
 }else{
  const result=name==='worker_result'?d.status:d.state;
  if(!RESULTS[name].includes(result))return {...out,state:'unknown',collection_error:'invalid_schema'};
  out.result=result;
  out.reason_code=REASONS.has(d.reason_code)?d.reason_code:REASONS.has(d.reason)?d.reason:null;
  out.request_id=id(d.request_id);out.mode=['audit','install'].includes(d.mode)?d.mode:null;
  out.installed_version=version(d.installed_version);out.target_version=version(d.latest_version)||version(d.target);
  const timeKeys=['checked_at','applied_at','rollback_at','started_at','finished_at','updated_at'];
  for(const k of timeKeys){if(d[k]!=null&&!stamp(d[k]))return {...out,state:'unknown',collection_error:'invalid_source_time'};}
  if(timeKeys.some(k=>d[k]!=null&&Date.parse(d[k])>now*1000)||(d.started_at&&d.finished_at&&Date.parse(d.finished_at)<Date.parse(d.started_at)))return {...out,state:'unknown',collection_error:'conflicting_source_dates'};
  const preferred=['merge','promotion','promotion_public'].includes(name)?['updated_at','finished_at','started_at']:['checked_at','applied_at','rollback_at'];
  out.source_updated_at=preferred.map(k=>stamp(d[k])).find(Boolean)||null;
  if(name==='worker_result'&&['running','deferred','failed','unavailable'].includes(result)&&!out.source_updated_at)out.coverage.push('worker_result_has_no_producer_timestamp_no_cycle_age_proven');
  else if(!out.source_updated_at)return {...out,state:'unknown',collection_error:'source_time_missing'};
  if(['failed','rollback','unavailable'].includes(result))out.state='failed';else out.state=result==='unknown'?'unknown':'observed';
  if(name.startsWith('promotion')&&['failed','applied_pending_git'].includes(result)&&!out.reason_code)out.coverage.push('failure_or_pending_reason_unknown');
 }
 if(out.state==='missing')out.state='observed';
 const eventAge=out.source_updated_at?now-Date.parse(out.source_updated_at)/1000:null;
 out.age_seconds=eventAge===null?null:Math.round(eventAge*1000)/1000;
 if(now-Date.parse(out.observed_at)/1000>120||(eventAge!==null&&eventAge>86400)){out.state='stale';out.collection_error='stale_evidence';}
 return out;
}
function project(input){
 if(!record(input)||!Number.isFinite(input.now_unix_seconds)||input.now_unix_seconds<0||input.now_unix_seconds>253402300799||!record(input.sources))return {schema_version:1,state:'unknown',collection_error:'invalid_schema',sources:[]};
 const now=input.now_unix_seconds,rows=SOURCES.map(k=>row(k,input.sources[k],now));
 const raw=n=>rows.find(r=>r.source===n)?.state!=='unknown'&&record(input.sources[n]?.data)?input.sources[n].data:{};
 const worker=rows.find(r=>r.source==='worker_result'),merge=rows.find(r=>r.source==='merge');
 const safe=rows.find(r=>r.source==='safe_update'),promotion=rows.find(r=>r.source==='promotion'),pub=rows.find(r=>r.source==='promotion_public');
 const a=sha(raw('merge').commit),b=sha(raw('promotion').source_commit);
 const usableVersion=r=>!['unknown','missing'].includes(r.state)?r.target_version:null;
 const correlation={worker_to_merge:'partial_target_only',worker_merge_target_matches:equalVersion(usableVersion(worker),usableVersion(merge)),safe_promotion_target_matches:equalVersion(usableVersion(safe),usableVersion(promotion)),promotion_public_target_matches:equalVersion(usableVersion(promotion),usableVersion(pub)),candidate_commit_matches:a&&b?a===b:null,cycle_20261026_0300_proven:false};
 return {schema_version:1,source:'fixed_kia_updater_readonly_diagnostic',observed_at:new Date(now*1000).toISOString(),state:rows.some(r=>r.state==='failed')?'attention':rows.some(r=>['missing','stale','unknown'].includes(r.state))?'incomplete':'observed',collection_error:null,sources:rows,correlation,coverage:['latest_receipts_not_cycle_history','no_filemtime_or_latest_audit_cycle_inference','no_vehicle_data_refresh_or_installs','no_raw_reason_message_paths_credentials_or_location']};
}
module.exports={project};
