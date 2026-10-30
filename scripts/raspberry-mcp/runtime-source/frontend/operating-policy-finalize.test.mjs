import test from 'node:test';import assert from 'node:assert/strict';
import {finalizeOperatingPolicy}from'./event_projection.mjs';
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
