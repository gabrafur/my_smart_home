import assert from 'node:assert/strict';
import {makeLightsRoute, lightDescriptors, actionDescriptors} from './lights-route.mjs';

const priorCalls=[];
const prior=async(q)=>{priorCalls.push(q);return q.method==='tools/list'?{jsonrpc:'2.0',id:q.id,result:{tools:[{name:'x'}]}}:{jsonrpc:'2.0',id:q.id,result:{ok:true}};};
const sent=[];
const route=makeLightsRoute(prior,async r=>{sent.push(r);return {state:'confirmed',collection_error:null};});

const list=await route({jsonrpc:'2.0',id:1,method:'tools/list'});
assert.deepEqual(list.result.tools.map(t=>t.name),['x','ha_lights_read','ha_light_set','ha_actions_read','ha_action_run','ha_entities_read','ha_service_call']);
assert.equal(lightDescriptors[1].annotations.readOnlyHint,false);

const ok=await route({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'ha_light_set',arguments:{host:'raspberry',target:'lampadas_garagem',state:'on'}}});
assert.equal(ok.result.structuredContent.state,'confirmed');
assert.deepEqual(sent.at(-1),{name:'ha_light_set',arguments:{host:'raspberry',target:'lampadas_garagem',state:'on'}});

for(const a of [{host:'raspberry',target:'rele_acionador_portao',state:'on'},{host:'raspberry',target:'lampadas_garagem',state:'toggle'},
  {host:'raspberry',target:'lampadas_garagem',state:'on',entity_id:'switch.rele_acionador_portao'},{host:'other',target:'lampadas_garagem',state:'on'}]){
 const r=await route({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'ha_light_set',arguments:a}});
 assert.equal(r.error.message,'registered_light_parameters_refused');
}
assert.equal(sent.length,1);

const read=await route({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'ha_lights_read',arguments:{host:'raspberry',target:null}}});
assert.deepEqual(sent.at(-1),{name:'ha_lights_read',arguments:{host:'raspberry'}});
assert.equal(read.result.isError,false);

const down=makeLightsRoute(prior,async()=>{throw Error('x')});
const d=await down({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'ha_lights_read',arguments:{host:'raspberry'}}});
assert.equal(d.result.structuredContent.collection_error,'lights_route_unavailable');

await route({jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'maintenance_read',arguments:{}}});
assert.equal(priorCalls.at(-1).params.name,'maintenance_read');
console.log('lights route: 6 groups passed');

// Audit sink receives every lighting call; capabilities gain a household_lights block.
const rows=[];
const caps=makeLightsRoute(async q=>({jsonrpc:'2.0',id:q.id,result:{content:[{type:'text',text:JSON.stringify({limits:['no_actuators']})}],structuredContent:{limits:['no_actuators']}}}),
 async()=>({state:'confirmed',collection_error:null}),row=>rows.push(row));
await caps({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'ha_light_set',arguments:{host:'raspberry',target:'lampada_varanda',state:'off'}}});
assert.deepEqual(rows,[{tool:'ha_light_set',id:7,success:true,state:'confirmed'}]);
const c=await caps({jsonrpc:'2.0',id:8,method:'tools/call',params:{name:'maintenance_capabilities',arguments:{host:'raspberry'}}});
assert.deepEqual(c.result.structuredContent.limits,['no_actuators']);
assert.deepEqual(c.result.structuredContent.household_lights.tools,['ha_lights_read','ha_light_set','ha_actions_read','ha_action_run','ha_entities_read','ha_service_call']);
assert.equal(JSON.parse(c.result.content[0].text).household_lights.scope,'whole_household_devices');
console.log('lights route: audit and capability annotation passed');

// Household actions: air conditioner, PC shutdown and gate pulse travel as target + verb only.
const acts=[];
const actRoute=makeLightsRoute(prior,async r=>{acts.push(r);return {state:'confirmed',collection_error:null};});
for(const [target,action] of [['ar_condicionado_escritorio','off'],['pc_gabriel','poweroff'],['portao_garagem','pulse']]){
 const r=await actRoute({jsonrpc:'2.0',id:9,method:'tools/call',params:{name:'ha_action_run',arguments:{host:'raspberry',target,action}}});
 assert.equal(r.result.structuredContent.state,'confirmed');
 assert.deepEqual(acts.at(-1),{name:'ha_action_run',arguments:{host:'raspberry',target,action}});
}
for(const a of [{target:'portao_garagem',action:'on'},{target:'portao_garagem',action:'open'},{target:'pc_gabriel',action:'reboot'},
  {target:'rele_acionador_portao',action:'pulse'},{target:'ar_condicionado_escritorio',action:'pulse'},{target:'portao_garagem',action:'pulse',entity_id:'switch.x'}]){
 const r=await actRoute({jsonrpc:'2.0',id:10,method:'tools/call',params:{name:'ha_action_run',arguments:{host:'raspberry',...a}}});
 assert.equal(r.error.message,'registered_light_parameters_refused');
}
assert.equal(acts.length,3);
assert.equal(actionDescriptors.find(d=>d.name==='ha_action_run').annotations.destructiveHint,true);
assert.equal(actionDescriptors.find(d=>d.name==='ha_actions_read').annotations.readOnlyHint,true);
await actRoute({jsonrpc:'2.0',id:11,method:'tools/call',params:{name:'ha_actions_read',arguments:{host:'raspberry',target:null}}});
assert.deepEqual(acts.at(-1),{name:'ha_actions_read',arguments:{host:'raspberry'}});
console.log('lights route: household actions passed');

// Whole-house control: find an entity, then one service call with plain data.
const house=[];
const hr=makeLightsRoute(prior,async r=>{house.push(r);return {state:'accepted',collection_error:null};});
await hr({jsonrpc:'2.0',id:12,method:'tools/call',params:{name:'ha_entities_read',arguments:{host:'raspberry',domain:'media_player',search:'tv'}}});
assert.deepEqual(house.at(-1),{name:'ha_entities_read',arguments:{host:'raspberry',domain:'media_player',search:'tv'}});
await hr({jsonrpc:'2.0',id:13,method:'tools/call',params:{name:'ha_service_call',arguments:{host:'raspberry',domain:'media_player',service:'turn_off',entity_id:'media_player.gabriel_s_fire_tv',data:{volume_level:0.2}}}});
assert.deepEqual(house.at(-1).arguments,{host:'raspberry',domain:'media_player',service:'turn_off',entity_id:'media_player.gabriel_s_fire_tv',data:{volume_level:0.2}});
for(const a of [{domain:'media_player',service:'turn_off',entity_id:'light.x'},{domain:'shell_command',service:'x',entity_id:'shell_command.x'},
  {domain:'light',service:'Turn On',entity_id:'light.x'},{domain:'light',service:'turn_on',entity_id:'light.x',data:{a:{b:1}}},
  {domain:'light',service:'turn_on',entity_id:'light.x',extra:1}]){
 const r=await hr({jsonrpc:'2.0',id:14,method:'tools/call',params:{name:'ha_service_call',arguments:{host:'raspberry',...a}}});
 assert.equal(r.error.message,'registered_light_parameters_refused');
}
assert.equal(house.length,2);
console.log('lights route: whole-house control passed');
