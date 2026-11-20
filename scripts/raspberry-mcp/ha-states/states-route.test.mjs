import assert from 'node:assert/strict';
import fs from 'node:fs';
import {makeStatesRoute, statesDescriptors} from './states-route.mjs';

const priorCalls=[];
const prior=async(q)=>{priorCalls.push(q);return q.method==='tools/list'?{jsonrpc:'2.0',id:q.id,result:{tools:[{name:'x'},{name:'ha_lights_read'}]}}:{jsonrpc:'2.0',id:q.id,result:{ok:true}};};
const sent=[],audited=[];
const route=makeStatesRoute(prior,async r=>{sent.push(r);return {state:'observed',entities:[],collection_error:null};},row=>audited.push(row));

const list=await route({jsonrpc:'2.0',id:1,method:'tools/list'});
assert.deepEqual(list.result.tools.map(t=>t.name),['x','ha_lights_read','ha_states_read']);
assert.equal(statesDescriptors[0].annotations.readOnlyHint,true);

// The route's enum and the Root policy name exactly the same entities.
const policy=JSON.parse(fs.readFileSync(new URL('./policy.json',import.meta.url)));
assert.deepEqual(statesDescriptors[0].inputSchema.properties.entity_id.anyOf[0].enum,Object.keys(policy.entities).sort());
for(const forbidden of ['alarm_control_panel.security_panel','lock.vehicle_primary_door_lock','switch.rele_acionador_portao'])
 assert.ok(!(forbidden in policy.entities),forbidden);

const all=await route({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'ha_states_read',arguments:{host:'raspberry',entity_id:null}}});
assert.deepEqual(sent.at(-1),{name:'ha_states_read',arguments:{host:'raspberry'}});
assert.equal(all.result.isError,false);
await route({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'ha_states_read',arguments:{host:'raspberry',entity_id:'sensor.raspberry_pi_load_5m'}}});
assert.deepEqual(sent.at(-1),{name:'ha_states_read',arguments:{host:'raspberry',entity_id:'sensor.raspberry_pi_load_5m'}});

for(const a of [{host:'raspberry',entity_id:'alarm_control_panel.security_panel'},{host:'raspberry',entity_id:'switch.rele_acionador_portao'},
  {host:'raspberry',service:'turn_on'},{host:'other'},null,[]]){
 const r=await route({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'ha_states_read',arguments:a}});
 assert.equal(r.error.message,'registered_entity_parameters_refused');
}
assert.equal(sent.length,2);
assert.deepEqual(audited.map(r=>r.success),[true,true]);

const down=makeStatesRoute(prior,async()=>{throw Error('x')});
const d=await down({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'ha_states_read',arguments:{host:'raspberry'}}});
assert.equal(d.result.structuredContent.collection_error,'states_route_unavailable');
assert.equal(d.result.isError,true);

await route({jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'ha_light_set',arguments:{}}});
assert.equal(priorCalls.at(-1).params.name,'ha_light_set');
console.log('states route: 6 groups passed');
