import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {eventPayloadSchema, terminalPayloadSchema} from './events-server.mjs';
import {projectLatestDeliveryReceipt} from './event_projection.mjs';

test('terminal payload has closed source and no recovery claim',()=>{
 assert.equal(eventPayloadSchema.oneOf.length,3);
 assert.deepEqual(terminalPayloadSchema.properties.source.enum,['registered_task_status']);
 assert.deepEqual(terminalPayloadSchema.properties.topic.enum,['task_terminal']);
 assert.deepEqual(terminalPayloadSchema.properties.functional_recovery_proven.enum,[false]);
});

test('terminal receipt projects only validated evidence and never functional recovery',()=>{
 const now=Date.parse('2026-01-02T00:00:00Z'),stamp='2026-01-02T00:00:00Z',hash='a'.repeat(64);
 const receipt={schema_version:1,source:'source_event_batch_transport_receipt_v1',observed_at:stamp,age_seconds:0,
 assistant_execution:'unknown',maximum_members:8,state:'observed',collection_error:null,batch_id:hash,
 subscription_id_sha256:hash,intent_at:stamp,data_age_seconds:0,dispatch_state:'uncertain',batch_membership_verified:true,
 membership_record_count:1,members_digest_sha256:hash,returned_members:1,members_truncated:false,
 delivery_kind:'task_terminal_summary_v1',functional_recovery_proven:false,
 members:[{source:'retained_registry_event',event_id:hash,object_id:createHash('sha256').update('task-terminal-operation-v1:'+'b'.repeat(32)).digest('hex'),revision:hash,phase:'terminal',operation_id:'b'.repeat(32),terminal_state:'completed',observed_at:stamp,age_seconds:0,collection_error:null,record_location:'current'}],
 transport:{source:'native_transport_completion',observed_at:null,age_seconds:null,state:'unknown',outcome:'outcome_unknown',sender_duration_ms:null,collection_error:'transport_completion_missing'}};
 const out=projectLatestDeliveryReceipt({latest_delivery_receipt:receipt},now);
 assert.equal(out.state,'observed');assert.equal(out.delivery_kind,'task_terminal_summary_v1');assert.equal(out.functional_recovery_proven,false);
 receipt.members[0].terminal_state='not_dispatched';assert.equal(projectLatestDeliveryReceipt({latest_delivery_receipt:receipt},now).members[0].terminal_state,'not_dispatched');
 receipt.functional_recovery_proven=true;assert.equal(projectLatestDeliveryReceipt({latest_delivery_receipt:receipt},now).state,'unknown');
});

test('events/list widens only the existing closed topic schema and preserves annotations',async()=>{
 const {makeEventRoute}=await import('./events-server.mjs');
 const original={name:'smart_home.observation',inputSchema:{type:'object',additionalProperties:false,properties:{project:{enum:['/mnt/data/docker']},topics:{type:'array',items:{type:'string',enum:['ha_notification']},minItems:1,maxItems:1,uniqueItems:true}},required:['project','topics']},annotations:{readOnlyHint:true},description:'old'};
 const route=makeEventRoute(async()=>({result:{events:[structuredClone(original)]}}));
 const result=await route({method:'events/list',id:1});const event=result.result.events[0];
 assert.deepEqual(event.annotations,original.annotations);assert.equal(event.inputSchema.additionalProperties,false);
 assert.deepEqual(event.inputSchema.required,original.inputSchema.required);
 assert.deepEqual(event.inputSchema.properties.topics.items.enum,['ha_notification','task_terminal']);
 assert.equal(event.inputSchema.properties.topics.maxItems,2);assert.match(event.description,/terminal/);
});

test('client policy remains separate from execution and observer failures are sanitized',async()=>{
 const {projectClientExecutionPolicy,projectTerminalSource}=await import('./event_projection.mjs');
 const at='2026-01-02T00:00:00Z',now=Date.parse(at);
 const policy={schema_version:1,kind:'client_incident_and_task_continuation_v1',enabled:true,expires_at:1800000100,client_neutral:true,target:'raspberry:/mnt/data/docker',
  allowed_tools:['codex_task_create','codex_task_send','codex_task_status','codex_task_reconcile','codex_task_list'],
  identity_recipe:{creation:'ha_object_id_prefix_32',task_key_prefix:'eva-admin-',send:'ha_revision_suffix_32',terminal:'exact_operation_id_from_registered_task_terminal_event'},
  limits:{maximum_sends_per_24h:48,minimum_spacing_seconds:60,concurrent_new_sends:1,backend_limits_authoritative:true},interface_confirmations_required:true,new_host_schedule_enabled:false,pending_OTP:'stop_dependent_effects',uncertain_operations:'observe_same_id_never_replay',workflows:['natural_actionable_ha_notification','registered_task_terminal'],authorization_does_not_override_backend:true};
 const v={source:'sealed_task_terminal_client_policy',observed_at:at,age_seconds:0,state:'approved',collection_error:null,approval_active:true,continuation_ready:false,execution_proven:false,policy};
 const result=projectClientExecutionPolicy(v,now);assert.equal(result.approval_active,true);assert.equal(result.execution_proven,false);
 const scope={state:'observed',topics:['ha_notification','task_terminal']},terminal={state:'observed'};
 assert.equal(projectClientExecutionPolicy({...v,continuation_ready:true},now,scope,terminal).continuation_ready,true);
 assert.equal(projectClientExecutionPolicy({...v,continuation_ready:true},now,scope,{state:'unknown'}).state,'unknown');
 assert.equal(projectClientExecutionPolicy({...v,policy:{...policy,private:'do_not_export'}},now).state,'unknown');
 for(const expiry of [true,'1800000100',null,-1,253402300800])assert.equal(projectClientExecutionPolicy({...v,policy:{...policy,expires_at:expiry}},now).state,'unknown');
 assert.equal(projectClientExecutionPolicy({...v,state:'expired',approval_active:false,policy:{...policy,expires_at:1}},now).approval_active,false);
 assert.equal(projectTerminalSource({state:'unknown',source_collection_error:'task_coordinator_busy'},now).source_collection_error,'task_coordinator_busy');
 assert.equal(projectTerminalSource({state:'unknown',source_collection_error:'private detail'},now).source_collection_error,null);
});
