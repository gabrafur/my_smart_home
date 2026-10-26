'use strict';
const assert=require('node:assert/strict');const {project}=require('./kia_model.cjs');
const now=Date.parse('2026-10-26T15:00:00Z')/1000,iso='2026-10-26T14:59:30Z',secret=['PRIVATE','ACCOUNT','COORDINATE','TOKEN'].join('_');
const envelope=data=>({observed_at:iso,collection_error:null,data});
const base=()=>({now_unix_seconds:now,sources:{
 sensor:envelope({state:'compatible',checked_at:iso,latest_version:'v3.13.0'}),
 safe_update:envelope({state:'compatible',checked_at:iso,latest_version:'v3.13.0'}),
 worker_result:envelope('kia-uvo-update status=compatible mode=install request_id=20261026T030000Z-123 latest_version=v3.13.0 checked_at='+iso),
 merge:envelope({state:'success',target:'v3.13.0',updated_at:iso,commit:'a'.repeat(40)}),
 promotion:envelope({state:'completed',target:'v3.13.0',updated_at:iso,source_commit:'a'.repeat(40)}),
 promotion_public:envelope({state:'completed',target:'v3.13.0',updated_at:iso}),
 pending:envelope({audit_requested:false,audit_processing:false,audit_followup:false,merge_requested:false,merge_processing:false}),
 schedule:envelope({crontab:'00 03 * * *',timezone:'America/Sao_Paulo',loaded:true,authorizes_install:true})}});
const get=(v,n)=>v.sources.find(r=>r.source===n);let cases=0;
function test(fn){fn();cases++;}
test(()=>{const v=project(base());assert.equal(v.state,'observed');assert.equal(v.correlation.candidate_commit_matches,true);assert.equal(v.correlation.cycle_20261026_0300_proven,false);});
test(()=>{const a=base();for(const env of Object.values(a.sources)){if(typeof env.data==='object')Object.assign(env.data,{reason:secret,message:secret,password:secret,latitude:secret,patch_path:secret});}const v=project(a);assert(!JSON.stringify(v).includes(secret));});
test(()=>{const a=base();a.sources.promotion.data={state:'failed',updated_at:iso,reason:null};const v=project(a),r=get(v,'promotion');assert.equal(r.state,'failed');assert.equal(r.reason_code,null);assert(r.coverage.includes('failure_or_pending_reason_unknown'));});
test(()=>{const a=base();delete a.sources.sensor;assert.equal(get(project(a),'sensor').state,'missing');a.sources.sensor=envelope(null);assert.equal(get(project(a),'sensor').state,'missing');});
test(()=>{const a=base();a.sources.safe_update.data.checked_at='2026-10-24T01:00:00Z';assert.equal(get(project(a),'safe_update').state,'stale');});
test(()=>{const a=base();a.sources.merge.collection_error=secret;const r=get(project(a),'merge');assert.equal(r.state,'unknown');assert.equal(r.collection_error,'collection_failed');assert(!JSON.stringify(project(a)).includes(secret));assert.equal(project(a).correlation.candidate_commit_matches,null);});
test(()=>{const a=base();a.sources.worker_result.data='kia-uvo-update status=failed status=compatible';assert.equal(get(project(a),'worker_result').collection_error,'invalid_schema');});
test(()=>{const a=base();a.sources.merge.data.started_at=iso;a.sources.merge.data.finished_at='2026-10-26T14:00:00Z';assert.equal(get(project(a),'merge').collection_error,'conflicting_source_dates');});
test(()=>{const a=base();delete a.sources.safe_update.data.checked_at;assert.equal(get(project(a),'safe_update').collection_error,'source_time_missing');a.sources.safe_update.data.checked_at='2027-01-01T00:00:00Z';assert.equal(get(project(a),'safe_update').collection_error,'conflicting_source_dates');});
test(()=>{const a=base();a.sources.worker_result.data='kia-uvo-update status=failed request_id=20261026T030000Z-123 mode=install latest_version=v3.13.0 reason=connect_timeout';const r=get(project(a),'worker_result');assert.equal(r.state,'failed');assert.equal(r.age_seconds,null);assert.equal(r.reason_code,'connect_timeout');});
test(()=>{const a=base();a.sources.schedule.data.timezone=secret;assert.equal(get(project(a),'schedule').collection_error,'invalid_schema');assert.equal(project(null).state,'unknown');assert.equal(project({now_unix_seconds:1e30,sources:{}}).state,'unknown');});
test(()=>{const a=base();assert.deepEqual(project(a),project(a));a.sources.merge.data.target='v3.14.0';assert.equal(project(a).correlation.worker_merge_target_matches,false);assert.equal(project(a).correlation.worker_to_merge,'partial_target_only');});
test(()=>{const a=base();a.sources.safe_update.data.checked_at='2026-02-30T01:00:00Z';assert.equal(get(project(a),'safe_update').collection_error,'invalid_source_time');a.sources.merge.data.updated_at='2027-01-01T00:00:00Z';assert.equal(project(a).correlation.worker_merge_target_matches,null);});
console.log(JSON.stringify({state:'passed',cases,production_effects:false}));
