import assert from 'node:assert/strict';
import {harness} from './startup-replay-harness.mjs';
const h=harness(),tab='monitoramento_zigbee_tab',f=h.flowFor(tab),t=Date.UTC(2026,0,1);
await h.run('zigbee_policy_default',{});
f.set('zigbee_boot_at__test',t);
const run=(id,msg,at)=>h.run(id,{...msg,_zigbee_test:true,monitor_now:at});
const tick=at=>run('zigbee_settle_tick_in',{},at);
const error=at=>run('zigbee_route_error_normalize',{payload:{level:'error',message:"Publish 'set' 'state' to 'teste_rota' failed: NWK_NO_ROUTE"}},at);
const routes=()=>f.get('zigbee_route_incidents_v1__test')||{};
const state=()=>Object.values(routes())[0];
const notifications=()=>h.dry.filter(x=>x.msg.notification);
await run('zigbee_network_observation_normalize',{payload:'online'},t);
await error(t+1000);assert.equal(state(),undefined,'no recovery load while network starts');
await tick(t+179999);assert.equal(state(),undefined);
await tick(t+180000);assert.equal(state().attempts,1,'buffered error starts once after readiness');
const firstNotices=notifications().length;assert.equal(firstNotices,1);
await error(t+180001);await error(t+180001);assert.equal(state().attempts,1,'duplicates share one incident');
const tx=state().pending_transaction;
async function response(kind,status,at,transaction=tx){return h.run(kind==='networkmap'?'zigbee_route_scan_policy_load':'zigbee_route_response_policy_load',{topic:'zigbee2mqtt/bridge/response/'+kind,payload:{status,transaction},monitor_now:at})}
await response('networkmap','ok',t+181000);
const configureCount=()=>h.dry.filter(x=>x.msg.zigbee_route_effect==='configure').length;
assert.equal(configureCount(),1);
await response('networkmap','ok',t+181001);assert.equal(configureCount(),1,'duplicate map cannot start concurrent configure');
await response('device/configure','ok',t+182000);assert.equal(state().phase,'verifying');assert.equal(state().incident_open,true);
assert.equal(notifications().length,firstNotices,'configure ok is not proof');
await response('device/configure','error',t+207000);assert.equal(state().phase,'failed','late error after ok must be accepted');
assert.equal(notifications().length,firstNotices,'intermediate failure stays silent');
await tick(t+1106999);assert.equal(state().attempts,1);
await tick(t+1107000);assert.equal(state().attempts,2,'native tick resumes retry without another real incident');
const tx2=state().pending_transaction;
await response('networkmap','ok',t+1108000,tx2);await response('device/configure','ok',t+1109000,tx2);
await tick(t+1409000);assert.equal(state().incident_open,true,'silence alone cannot confirm recovery');
await run('zigbee_route_telemetry',{topic:'zigbee2mqtt/teste_rota',payload:{state:'ON'},retain:true},t+1410000);
await tick(t+1410000);assert.equal(state().incident_open,true,'retained device payload is not evidence');
await run('zigbee_route_telemetry',{topic:'zigbee2mqtt/teste_rota',payload:{state:'ON'},retain:false},t+1410001);
await tick(t+1410001);assert.equal(state().incident_open,false);assert.equal(notifications().length,firstNotices+1);
await tick(t+1410002);assert.equal(notifications().length,firstNotices+1,'recovery emits once');
// Availability oscillations and retained snapshots do not close a persisted incident immediately.
const component=(value,at)=>run('zigbee_component_policy_load',{topic:'zigbee2mqtt/test_component/availability',payload:value},at);
await component('offline',t+1500000);let count=notifications().length;
await tick(t+1529999);assert.equal(notifications().length,count);
await tick(t+1530000);assert.equal(notifications().length,count+1);
await component('online',t+1540000);await component('offline',t+1570000);await tick(t+1600000);assert.equal(notifications().length,count+1,'availability flap keeps incident open');
await component('online',t+1610000);await tick(t+1670000);assert.equal(notifications().length,count+2);
assert.equal(f.get('zigbee_route_incidents_v1','persistent'),undefined,'test state isolated');
assert.ok(h.dry.length>5);assert.ok(!h.seen.includes('zigbee_route_recovery_mqtt'));assert.ok(!h.seen.includes('zigbee_route_configure_mqtt'));
console.log('Zigbee graph replay: startup, duplicate messages/maps, late configure failure, timed retry, fresh evidence, stability, availability flap and dry-run passed.');
// Interrupted requests are bounded even when neither map nor configure responds.
const stalled=harness(),sf=stalled.flowFor(tab);
await stalled.run('zigbee_policy_default',{});sf.set('zigbee_boot_at__test',t);
await stalled.run('zigbee_network_observation_normalize',{_zigbee_test:true,monitor_now:t,payload:'online'});
await stalled.run('zigbee_route_error_normalize',{_zigbee_test:true,monitor_now:t+180000,payload:{level:'error',message:"Publish 'set' to 'teste_rota' failed: NWK_NO_ROUTE"}});
for(const delta of [1080000,1980000,2880000,3780000])await stalled.run('zigbee_settle_tick_in',{_zigbee_test:true,monitor_now:t+delta});
const exhausted=Object.values(sf.get('zigbee_route_incidents_v1__test'))[0];
assert.equal(exhausted.attempts,3);assert.equal(exhausted.exhaustion_notified,true);
assert.equal(stalled.dry.filter(x=>x.msg.topic==='zigbee2mqtt/bridge/request/networkmap').length,3);
assert.equal(stalled.dry.filter(x=>x.msg.notification).length,2,'one opening and one final exhaustion');
// The same read version cannot reserve two attempts across interleaved messages.
const race=harness(),rf=race.flowFor(tab);await race.run('zigbee_policy_default',{});
const runFunction=(id,msg)=>new Function('msg','flow','node',race.by.get(id).func)(msg,rf,{status(){}});
const input={_zigbee_test:true,policy:rf.get('zigbee_monitor_policy_v2','persistent'),zigbee_route_key:'race',zigbee_route_device:'test_device',zigbee_route_now:t,zigbee_route_now_iso:new Date(t).toISOString()};
const a=runFunction('zigbee_route_state_read',structuredClone(input));const b=structuredClone(a);
for(const m of [a,b]){m.zigbee_route_action='open';m.zigbee_route_event='route_failure'}
assert.ok(runFunction('zigbee_route_state_mutate',a));assert.equal(runFunction('zigbee_route_state_mutate',b),null);
assert.equal(rf.get('zigbee_route_incidents_v1__test').race.attempts,1);
// Restart preserves the incident but discards live proof and restarts stability.
const restarted=harness(),rr=restarted.flowFor(tab);await restarted.run('zigbee_policy_default',{});
rr.set('zigbee_route_incidents_v1__test',{route:{...exhausted,phase:'verifying',attempts:1,exhaustion_notified:false,pending_transaction:'synthetic',verification_started_at:new Date(t+1000).toISOString(),last_failure_at:new Date(t).toISOString(),next_retry_at:new Date(t+2000000).toISOString()}});
rr.set('zigbee_boot_at__test',t+600000);
await restarted.run('zigbee_network_observation_normalize',{_zigbee_test:true,monitor_now:t+600000,payload:'online'});
await restarted.run('zigbee_settle_tick_in',{_zigbee_test:true,monitor_now:t+900000});assert.equal(rr.get('zigbee_route_incidents_v1__test').route.incident_open,true);
await restarted.run('zigbee_route_telemetry',{_zigbee_test:true,monitor_now:t+900001,topic:'zigbee2mqtt/teste_rota',payload:{state:'ON'}});
await restarted.run('zigbee_settle_tick_in',{_zigbee_test:true,monitor_now:t+900001});assert.equal(rr.get('zigbee_route_incidents_v1__test').route.incident_open,false);
console.log('Zigbee additional replays: unanswered-request exhaustion, atomic reservation and persisted restart without old evidence passed.');

// A device can heal naturally after attempts are exhausted; two fresh reports
// spanning the stability window close the same incident without another configure.
await stalled.run('zigbee_route_telemetry',{_zigbee_test:true,monitor_now:t+4000000,topic:'zigbee2mqtt/teste_rota',payload:{state:'ON'}});
await stalled.run('zigbee_settle_tick_in',{_zigbee_test:true,monitor_now:t+4300000});
assert.equal(Object.values(sf.get('zigbee_route_incidents_v1__test'))[0].incident_open,true,'old report plus silence is insufficient');
await stalled.run('zigbee_route_telemetry',{_zigbee_test:true,monitor_now:t+4300001,topic:'zigbee2mqtt/teste_rota',payload:{state:'ON'}});
await stalled.run('zigbee_settle_tick_in',{_zigbee_test:true,monitor_now:t+4300001});
assert.equal(Object.values(sf.get('zigbee_route_incidents_v1__test'))[0].incident_open,false,'natural recovery remains observable after exhaustion');
assert.equal(stalled.dry.filter(x=>x.msg.topic==='zigbee2mqtt/bridge/request/networkmap').length,3,'natural recovery does not reset the attempt budget');
