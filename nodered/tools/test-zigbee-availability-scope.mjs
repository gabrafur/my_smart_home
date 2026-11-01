// Private synthetic replay. Parent runs serially; this file sends no MQTT/HA calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {harness} from './startup-replay-harness.mjs';
const require=createRequire(import.meta.url),base=new URL('./',import.meta.url);
const {sanitizeContent}=require('../../scripts/raspberry-mcp/runtime-source/ha-notices/content_sanitizer.cjs');
const body=name=>fs.readFileSync(new URL('functions/'+name,base),'utf8');
const tab='monitoramento_zigbee_tab', t=Date.UTC(2026,0,1), target='synthetic_component';
async function replay(route,identityMap=null){
 const h=harness(),f=h.flowFor(tab);
 assert.equal(h.by.get('zigbee_component_state_read').func.trim(),body('zigbee-component-state-read.js').trim(),'generator must embed the reviewed reader');
 assert.equal(h.by.get('zigbee_component_notification_build').func.trim(),body('zigbee-component-notification-build.js').trim(),'generator must embed the reviewed producer');
 await h.run('zigbee_policy_default',{});
 f.set('zigbee_boot_at__test',t);
 f.set('zigbee_component_incidents_v1__test',{[target]:{offline:true,outage_started_at:new Date(t).toISOString(),last_notification_at:new Date(t).toISOString()}});
 f.set('zigbee_route_incidents_v1__test',route?{r:route}:{});
 if(identityMap)f.set('zigbee_device_name_by_ieee_v1__test',identityMap);
 // A conflicting production-only route must never leak into the test cohort.
 f.set('zigbee_route_incidents_v1',{foreign:{device:target,incident_open:true,phase:'failed'}},'persistent');
 const production=JSON.stringify(f.get('zigbee_route_incidents_v1','persistent'));
 const send=(id,msg,delta)=>h.run(id,{...msg,_zigbee_test:true,monitor_now:t+delta});
 await send('zigbee_network_observation_normalize',{payload:'online'},0);
 await send('zigbee_component_normalize',{topic:'zigbee2mqtt/'+target+'/availability',payload:'online',retain:false},180000);
 await send('zigbee_settle_tick_in',{},240001);
 const notices=h.dry.filter(x=>x.msg.notification?.title==='Componente Zigbee recuperado');
 assert.equal(notices.length,1,'same full test path reaches one existing dry-run notification terminal');
 assert.equal(JSON.stringify(f.get('zigbee_route_incidents_v1','persistent')),production,'test leaves production route state untouched');
 return {h,f,notice:notices[0].msg};
}

const pending={device:target,incident_open:true,phase:'failed',attempts:3,exhaustion_notified:true,pending_transaction:null};
const first=await replay(pending);
assert.equal(first.notice.zigbee_component_route_context.state,'pending');
assert.equal(first.notice.zigbee_component_route_context.command_functional_health,'unknown');
assert.match(first.notice.notification.message,/O incidente de rota permanece aberto/);
assert.equal(first.f.get('zigbee_route_incidents_v1__test').r.incident_open,true);
assert.equal(first.f.get('zigbee_route_incidents_v1__test').r.attempts,3);
assert.equal(first.f.get('zigbee_component_incidents_v1__test')[target].offline,false,'availability lifecycle remains independently valid');
assert.equal(first.notice.notification.dismiss_id.startsWith('zigbee_component_'),true,'availability does not dismiss a route incident');
assert.equal(first.h.dry.some(x=>x.msg.zigbee_route_effect==='configure'||x.msg.topic==='zigbee2mqtt/bridge/request/networkmap'),false,'a return notification never starts another RF recovery');

const clean=await replay({device:target,incident_open:false,phase:'recovered'});
assert.equal(clean.notice.zigbee_component_route_context.state,'no_open_incident');
assert.equal(clean.notice.zigbee_component_route_context.command_functional_health,'unknown');
assert.doesNotMatch(clean.notice.notification.message,/O incidente de rota permanece aberto/);

const unknown=await replay(null);
assert.equal(unknown.notice.zigbee_component_route_context.state,'unknown');
assert.equal(unknown.notice.zigbee_component_route_context.incident_open,null);
assert.doesNotMatch(unknown.notice.notification.message,/O incidente de rota permanece aberto/,'production-only route cannot contaminate test state');

const newer=await replay({...pending,phase:'verifying',attempts:1,exhaustion_notified:false});
const dto=sanitizeContent(newer.notice.notification.title,newer.notice.notification.message);
assert(dto.reason_codes.includes('zigbee_component_recovery_route_pending'));
assert(!dto.reason_codes.includes('zigbee_route_unconfirmed'),'pending does not falsely say attempts exhausted');
assert(!JSON.stringify(dto).includes(target),'private subject never leaves the sanitizer');
const legacy=sanitizeContent('Componente Zigbee recuperado','O componente Zigbee “synthetic_component” voltou a ficar disponível em 01/01/2026, 12:00:00.');
assert(legacy.message_codes.includes('zigbee_component_recovery_notice'));
assert(!legacy.reason_codes.includes('zigbee_component_recovery_route_pending'),'legacy valid notice remains unchanged');
const injected=sanitizeContent(first.notice.notification.title,first.notice.notification.message+' PRIVATE_SENTINEL');
assert(!JSON.stringify(injected).includes('PRIVATE_SENTINEL'));
const renamed=await replay({...pending,device:'previous_synthetic_name',ieee:'0x00124b0000000001'},
 {'0x00124b0000000001':target});
assert.equal(renamed.notice.zigbee_component_route_context.state,'pending','stable IEEE keeps route relation after a friendly-name change');
console.log('prepared synthetic cases: pending+availability/full dry-run, independent closed route, unknown/test isolation, verifying-not-exhausted, legacy compatibility, private suffix withholding, stable IEEE relation');
