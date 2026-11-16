import assert from 'node:assert/strict';
import {makeLightsRoute, lightDescriptors} from './lights-route.mjs';

const priorCalls=[];
const prior=async(q)=>{priorCalls.push(q);return q.method==='tools/list'?{jsonrpc:'2.0',id:q.id,result:{tools:[{name:'x'}]}}:{jsonrpc:'2.0',id:q.id,result:{ok:true}};};
const sent=[];
const route=makeLightsRoute(prior,async r=>{sent.push(r);return {state:'confirmed',collection_error:null};});

const list=await route({jsonrpc:'2.0',id:1,method:'tools/list'});
assert.deepEqual(list.result.tools.map(t=>t.name),['x','ha_lights_read','ha_light_set']);
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
assert.deepEqual(c.result.structuredContent.household_lights.tools,['ha_lights_read','ha_light_set']);
assert.equal(JSON.parse(c.result.content[0].text).household_lights.scope,'registered_household_lights_only');
console.log('lights route: audit and capability annotation passed');
