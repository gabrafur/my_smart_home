import test from 'node:test';import assert from 'node:assert/strict';
import {finalizeOperatingPolicy}from'./event_projection.mjs';
import {finalizeOperatingPolicy as finalizeRepairOperatingPolicy}from'../repair-control/event_projection.mjs';
const now=1793390000000;
const fixture=()=>({schema_version:1,client_neutral:true,
 authority:{admission_active:true,revoked:false,expires_at:now/1000+100},
 evidence:{task_admission:{observed_at:new Date(now).toISOString()}},coverage:[],actions:[
 {id:'send',tool:'codex_task_send',role:'privileged_task',state:'blocked',reason:'actual_frontend_catalogue_required',admission_state:'ready',admission_reason:'existing_preflight'},
 {id:'storage',tool:'admin_action_apply',role:'storage_effect',admission_state:'requires_confirmation',admission_reason:'existing_interface_confirmation_required',interface_confirmation_required:true},
 ]});
test('actual catalogue exposes only already admitted opportunity',()=>{
 const source=fixture(),out=finalizeOperatingPolicy(source,['codex_task_send','admin_action_apply'],now);
 assert.equal(out.actions[0].state,'ready');assert.equal(source.actions[0].state,'blocked');
 assert.equal(out.actions[1].state,'requires_confirmation');
});
test('closed or expired or revoked admission never becomes ready',()=>{
 for(const change of[{admission_active:false},{expires_at:now/1000},{revoked:true}]){
  const value=fixture();Object.assign(value.authority,change);
  assert.equal(finalizeOperatingPolicy(value,['codex_task_send'],now).actions[0].state,'blocked');
 }
});
test('canonical denied admission cannot be promoted by present tool',()=>{
 const value=fixture();value.actions[0].admission_state='blocked';value.actions[0].admission_reason='uncertain_operation';
 assert.equal(finalizeOperatingPolicy(value,['codex_task_send'],now).actions[0].state,'blocked');
});
test('unsupported tool remains distinct from blocked authority',()=>{
 const value=fixture();value.authority.admission_active=false;
 assert.equal(finalizeOperatingPolicy(value,[],now).actions[0].state,'unsupported');
});
test('UI confirmation is never silently satisfied by projection',()=>{
 const value=fixture();value.actions[1].admission_state='ready';
 assert.equal(finalizeOperatingPolicy(value,['admin_action_apply'],now).actions[1].state,'requires_confirmation');
});
test('stale or missing metadata closes an otherwise admitted task',()=>{
 for(const observed_at of[null,new Date(now-120001).toISOString()]){
  const value=fixture();value.evidence.task_admission.observed_at=observed_at;
  assert.equal(finalizeOperatingPolicy(value,['codex_task_send'],now).actions[0].state,'blocked');
 }
});
test('workspace lease cannot reopen administration or legacy task scope',()=>{
 const value=fixture();
 Object.assign(value.authority,{admission_active:false,administrative_expires_at:now/1000-1,
  workspace_admission_active:true,workspace_expires_at:now/1000+100});
 value.actions.push({id:'workspace',tool:'codex_task_send',role:'workspace_task',admission_state:'ready'});
 const out=finalizeOperatingPolicy(value,['codex_task_send'],now);
 assert.equal(out.actions[0].state,'blocked');assert.equal(out.actions[2].state,'ready');
});
test('workspace has its own expiry, revocation and evidence freshness gates',()=>{
 for(const change of[{workspace_admission_active:false},{workspace_expires_at:now/1000},{revoked:true}]){
  const value=fixture();value.actions[0].role='workspace_task';
  Object.assign(value.authority,{workspace_admission_active:true,workspace_expires_at:now/1000+100},change);
  assert.equal(finalizeOperatingPolicy(value,['codex_task_send'],now).actions[0].state,'blocked');
 }
 const value=fixture();value.actions[0].role='workspace_task';
 Object.assign(value.authority,{workspace_admission_active:true,workspace_expires_at:now/1000+100});
 value.evidence.task_admission.observed_at=new Date(now-120001).toISOString();
 assert.equal(finalizeOperatingPolicy(value,['codex_task_send'],now).actions[0].state,'blocked');
});

function persistentWorkspaceFixture(){return {
 schema_version:1,client_neutral:true,collection_error:null,
 authority:{workspace_expires_at:null,workspace_admission_active:true,revoked:false,
  task_policy_schema:'raspberry-task-policy-v2',task_policy_lease_kind:'persistent_revocable',
  admission_active:false,administrative_expires_at:null,maximum_shared_sends_per_24h:48,minimum_spacing_seconds:60,remaining_sends:47},
 evidence:{task_admission:{source:'existing_task_policy_and_readonly_shared_ledgers',state:'observed',collection_error:null,observed_at:new Date(now-1000).toISOString()}},
 actions:[{tool:'codex_task_send',role:'workspace_task',admission_state:'ready',admission_reason:'existing_workspace_admission',interface_confirmation_required:true}]
};}
const projectPersistentWorkspace=(value)=>{
 const catalogue=['codex_task_send','codex_task_status'];
 const out=finalizeOperatingPolicy(value,catalogue,now);
 assert.deepEqual(finalizeRepairOperatingPolicy(value,catalogue,now),out);
 return out;
};
test('persistent v2 with canonical active peer retains interface confirmation',()=>{
 const input=persistentWorkspaceFixture(),before=structuredClone(input),out=projectPersistentWorkspace(input);
 assert.equal(out.actions[0].state,'requires_confirmation');assert.equal(out.actions[0].reason,'existing_interface_confirmation_required');
 assert.deepEqual(input,before);assert.deepEqual(out.authority,input.authority);
});
test('null expiry never grants administration, even an inconsistent active field',()=>{
 for(const active of [false,true]){const value=persistentWorkspaceFixture();value.actions[0].role='privileged_task';value.authority.admission_active=active;
  assert.equal(projectPersistentWorkspace(value).actions[0].state,'blocked');}
});
test('unknown or inactive canonical peer remains blocked',()=>{
 for(const active of [false,null,undefined]){const value=persistentWorkspaceFixture();value.authority.workspace_admission_active=active;
  assert.equal(projectPersistentWorkspace(value).actions[0].state,'blocked');}
});
test('persistent exception requires exact schema, lease kind, explicit null expiry and false revocation',()=>{
 const changes=[['task_policy_schema','raspberry-task-policy-v1'],['task_policy_lease_kind','finite'],['workspace_expires_at',undefined],['revoked',true],['revoked',null]];
 for(const [key,change] of changes){const value=persistentWorkspaceFixture();value.authority[key]=change;assert.equal(projectPersistentWorkspace(value).actions[0].state,'blocked',key);}
});
test('task source errors and unknown source state block null expiry',()=>{
 for(const mutate of [v=>v.evidence.task_admission.collection_error='source_unavailable',v=>delete v.evidence.task_admission.collection_error,v=>v.evidence.task_admission.state='unknown']){
  const value=persistentWorkspaceFixture();mutate(value);assert.equal(projectPersistentWorkspace(value).actions[0].state,'blocked');}
});
test('stale and future source clocks remain blocked using existing freshness gate',()=>{
 for(const time of [now-120001,now+1]){const value=persistentWorkspaceFixture();value.evidence.task_admission.observed_at=new Date(time).toISOString();assert.equal(projectPersistentWorkspace(value).actions[0].state,'blocked');}
});
test('unrelated global partial collection does not override fresh canonical task source',()=>{
 const value=persistentWorkspaceFixture();value.collection_error='partial_collection_failure';assert.equal(projectPersistentWorkspace(value).actions[0].state,'requires_confirmation');
});
test('existing finite workspace behavior remains unchanged',()=>{
 const value=persistentWorkspaceFixture();value.authority.workspace_expires_at=now/1000+60;value.authority.task_policy_schema='legacy';value.authority.task_policy_lease_kind='finite';
 value.evidence.task_admission.state='unknown';value.evidence.task_admission.collection_error='legacy_metadata';
 assert.equal(projectPersistentWorkspace(value).actions[0].state,'requires_confirmation');
 value.authority.workspace_expires_at=now/1000;assert.equal(projectPersistentWorkspace(value).actions[0].state,'blocked');
});
test('existing finite administrative expiry still cannot borrow workspace standing grant',()=>{
 const value=persistentWorkspaceFixture();value.actions[0].role='privileged_task';value.authority.admission_active=true;value.authority.administrative_expires_at=now/1000-1;
 assert.equal(projectPersistentWorkspace(value).actions[0].state,'blocked');
});
test('canonical budget denial is preserved',()=>{
 const value=persistentWorkspaceFixture();value.actions[0].admission_state='blocked';value.actions[0].admission_reason='shared_send_budget_exhausted_or_unknown';
 const out=projectPersistentWorkspace(value);assert.equal(out.actions[0].state,'blocked');assert.equal(out.actions[0].reason,'shared_send_budget_exhausted_or_unknown');
 assert.equal(out.authority.maximum_shared_sends_per_24h,48);assert.equal(out.authority.minimum_spacing_seconds,60);assert.equal(out.authority.remaining_sends,47);
});
test('missing catalogue tool stays unsupported and missing canonical decision stays blocked',()=>{
 const value=persistentWorkspaceFixture();assert.equal(finalizeOperatingPolicy(value,[],now).actions[0].state,'unsupported');
 delete value.actions[0].admission_state;assert.equal(projectPersistentWorkspace(value).actions[0].state,'blocked');
});
