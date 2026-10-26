const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {project}=require('./kia_model.cjs');
const iso='2026-10-26T21:00:00Z',now=Date.parse(iso)/1000;
const row=data=>project({now_unix_seconds:now,sources:{promotion:{observed_at:iso,collection_error:null,data}}}).sources.find(r=>r.source==='promotion');
const base={state:'failed',target:'v3.20.0',updated_at:iso,reason_code:'runtime_application_unconfirmed',failure_stage:'runtime_apply',effect_state:'runtime_outcome_unknown'};
test('MCP projection preserves fixed stage and attempt-only uncertainty',()=>{
 const r=row({...base,reason:'PRIVATE_TOKEN=secret',stack:'PRIVATE_STACK',vehicle_location:'PRIVATE_COORDINATES'});
 assert.equal(r.failure_stage,'runtime_apply');assert.equal(r.effect_state,'runtime_outcome_unknown');assert.equal(r.reason_code,'runtime_application_unconfirmed');assert.ok(r.coverage.includes('effect_state_current_attempt_only_not_current_service_or_vehicle_health'));assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
for(const patch of [{failure_stage:'PRIVATE_VALUE'},{effect_state:'runtime_not_attempted'},{failure_stage:'__proto__'},{failure_stage:{private:'PRIVATE'}}])test('MCP inconsistent or hostile stage stays unknown '+JSON.stringify(patch),()=>{
 const r=row({...base,...patch});assert.equal(r.failure_stage,null);assert.equal(r.effect_state,'unknown');assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
test('legacy failure stays without invented stage',()=>{const r=row({state:'failed',updated_at:iso,reason_code:null});assert.equal(r.failure_stage,null);assert.equal(r.effect_state,'unknown');assert.equal(r.reason_code,null);});
test('old evidence retains stale classification with stage metadata',()=>{const r=project({now_unix_seconds:now+86401,sources:{promotion:{observed_at:new Date((now+86401)*1000).toISOString(),data:base,collection_error:null}}}).sources.find(r=>r.source==='promotion');assert.equal(r.state,'stale');assert.equal(r.failure_stage,'runtime_apply');});
test('collection failure cannot export stale data as current stage',()=>{const r=project({now_unix_seconds:now,sources:{promotion:{observed_at:iso,data:base,collection_error:'synthetic failure'}}}).sources.find(r=>r.source==='promotion');assert.equal(r.state,'unknown');assert.equal(r.failure_stage,null);assert.equal(r.effect_state,'unknown');});
