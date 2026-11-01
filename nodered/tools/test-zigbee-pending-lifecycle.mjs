// Private candidate replay only. The parent runs this serially; never invokes production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {flows, harness} from './startup-replay-harness.mjs';
const t=Date.UTC(2026,0,1),tab='monitoramento_zigbee_tab';
async function fixture(){
 const h=harness(),f=h.flowFor(tab);await h.run('zigbee_policy_default',{});f.set('zigbee_boot_at__test',t);
 const run=(id,msg,at)=>h.run(id,{...msg,_zigbee_test:true,monitor_now:at});
 const tick=at=>run('zigbee_settle_tick_in',{},at);
 const error=at=>run('zigbee_route_error_normalize',{payload:{level:'error',message:"Publish 'set' to 'test_device' failed: NWK_NO_ROUTE"}},at);
 const state=()=>Object.values(f.get('zigbee_route_incidents_v1__test')||{})[0];
 const response=(kind,status,at,transaction=state().pending_transaction)=>run(kind==='networkmap'?'zigbee_route_scan_policy_load':'zigbee_route_response_policy_load',
  {topic:'zigbee2mqtt/bridge/response/'+kind,payload:{status,transaction,...(status==='error'?{error:'NWK_NO_ROUTE'}:{})}},at);
 const count=kind=>h.dry.filter(x=>x.msg.zigbee_route_effect===kind).length;
 await run('zigbee_network_observation_normalize',{payload:'online'},t);await error(t+180000);
 return {h,f,run,tick,error,state,response,count};
}
let cases=0;
// Native networkmap still pending at15min: one operation only, same ID preserved.
{
 const x=await fixture(),id=x.state().pending_transaction;await x.tick(t+1080000);await x.tick(t+1980000);
 assert.equal(x.count('route_scan'),1);assert.equal(x.state().attempts,1);
 assert.equal(x.state().pending_transaction,id);assert.equal(x.state().native_completion_state,'unknown');
 assert.equal(x.state().phase,'scanning');cases++;
}
// Native configure pending at15min: no second scan or configure.
{
 const x=await fixture();await x.response('networkmap','ok',t+181000);const id=x.state().pending_transaction;
 assert.equal(x.count('configure'),1);await x.tick(t+1080000);
 assert.equal(x.count('route_scan'),1);assert.equal(x.count('configure'),1);assert.equal(x.state().attempts,1);
 assert.equal(x.state().pending_transaction,id);assert.equal(x.state().native_completion_state,'unknown');cases++;
}
// A genuine late map reply reconciles without chaining a new configure effect.
{
 const x=await fixture(),id=x.state().pending_transaction;await x.tick(t+1080000);
 await x.response('networkmap','ok',t+1080001,id);assert.equal(x.count('configure'),0);
 assert.equal(x.state().pending_transaction,null);assert.equal(x.state().last_terminal_transaction,id);
 assert.equal(x.state().last_terminal_status,'ok');assert.equal(x.state().native_completion_state,'terminal');
 await x.tick(t+1080002);assert.equal(x.count('route_scan'),1);cases++;
}
// Explicit terminal error unlocks only a normal cooldown-bound next attempt.
{
 const x=await fixture();await x.response('networkmap','error',t+181000);
 assert.equal(x.state().pending_transaction,null);assert.equal(x.state().native_completion_state,'terminal');
 await x.tick(t+1080999);assert.equal(x.count('route_scan'),1);
 await x.tick(t+1081000);assert.equal(x.count('route_scan'),2);assert.equal(x.state().attempts,2);cases++;
}
// Fresh map ok before deadline still performs exactly one approved next stage.
{
 const x=await fixture(),id=x.state().pending_transaction;await x.response('networkmap','ok',t+181000);
 assert.equal(x.count('configure'),1);assert.equal(x.state().native_stage,'configure');
 await x.response('networkmap','ok',t+181001,id);assert.equal(x.count('configure'),1);cases++;
}
// Configure completion and its late correlated failure retain their transaction.
{
 const x=await fixture();await x.response('networkmap','ok',t+181000);const id=x.state().pending_transaction;
 await x.response('device/configure','ok',t+182000,id);assert.equal(x.state().pending_transaction,null);
 assert.equal(x.state().phase,'verifying');assert.equal(x.state().incident_open,true);
 await x.response('device/configure','error',t+207000,id);assert.equal(x.state().phase,'failed');
 assert.equal(x.state().last_terminal_transaction,id);assert.equal(x.state().last_terminal_status,'error');cases++;
}
// Unknown native operation cannot be erased by elapsed time or a foreign reply.
{
 const x=await fixture(),id=x.state().pending_transaction;await x.tick(t+1080000);
 await x.response('networkmap','error',t+1080001,'nodered-zigbee-route-test-foreign-1');
 await x.error(t+1080002);assert.equal(x.state().pending_transaction,id);
 assert.equal(x.state().attempts,1);assert.equal(x.count('route_scan'),1);cases++;
}
// Passive RF recovery is independent: two reports300s apart, native result unknown.
{
 const x=await fixture(),id=x.state().pending_transaction;await x.tick(t+1080000);
 await x.run('zigbee_route_telemetry',{topic:'zigbee2mqtt/test_device',payload:{state:'OFF'}},t+1081000);
 await x.tick(t+1381000);assert.equal(x.state().incident_open,true,'silence is insufficient');
 await x.run('zigbee_route_telemetry',{topic:'zigbee2mqtt/test_device',payload:{state:'OFF'}},t+1381001);
 await x.tick(t+1381001);assert.equal(x.state().incident_open,false);
 assert.equal(x.state().pending_transaction,id);assert.equal(x.state().native_completion_state,'unknown');
 assert.equal(x.count('route_scan'),1);assert.equal(x.count('configure'),0);
 await x.response('networkmap','ok',t+1381002,id);
 assert.equal(x.state().incident_open,false);assert.equal(x.state().phase,'recovered');
 assert.equal(x.state().pending_transaction,null);assert.equal(x.count('configure'),0);cases++;
}
// Historical three-attempt incident is preserved; neither time nor state read resets it.
{
 const x=await fixture(),saved=x.f.get('zigbee_route_incidents_v1__test'),key=Object.keys(saved)[0];
 saved[key]={...saved[key],phase:'failed',attempts:3,pending_transaction:null,native_completion_state:undefined,
  exhaustion_notified:true,next_retry_at:new Date(t+1000).toISOString()};
 x.f.set('zigbee_route_incidents_v1__test',saved);await x.tick(t+4000000);
 assert.equal(x.state().attempts,3);assert.equal(x.count('route_scan'),1);
 assert.equal(x.state().native_completion_state,'unknown');assert.equal(x.state().exhaustion_notified,true);cases++;
}
// A stale caller bypassing the visual switch is refused at the atomic effect reservation.
{
 const x=await fixture(),f=x.f,by=x.h.by;
 const read=new Function('msg','flow','node',by.get('zigbee_route_state_read').func);
 const mutate=new Function('msg','flow','node',by.get('zigbee_route_state_mutate').func);
 const key=Object.keys(f.get('zigbee_route_incidents_v1__test'))[0],before=structuredClone(x.state());
 const message=read({_zigbee_test:true,zigbee_route_key:key,zigbee_route_now:t+2000000,
  zigbee_route_now_iso:new Date(t+2000000).toISOString(),policy:f.get('zigbee_monitor_policy_v2','persistent')},f,{});
 message.zigbee_route_action='retry';assert.equal(mutate(message,f,{status(){}}),null);
 assert.deepEqual(x.state(),before);cases++;
}
// The graph must retain its final dry-run boundary for every fixture.
{
 const x=await fixture(),record=x.f.get('zigbee_last_dry_run_v1__test');
 assert.equal(record.dispatched,false);assert.equal(record.simulated,true);
 assert.ok(x.h.dry.every(r=>r.msg._zigbee_test===true));
 assert.ok(!x.h.seen.includes('zigbee_route_recovery_mqtt'));
 assert.ok(!x.h.seen.includes('zigbee_route_configure_mqtt'));
 assert.equal(x.f.get('zigbee_route_incidents_v1','persistent'),undefined);cases++;
}
console.log(JSON.stringify({synthetic_cases:cases,RF_commands:0,MQTT_writes:0,production_context_writes:0,
 native_work_not_cancelled_by_deadline:true,whole_goal_complete:false}));
