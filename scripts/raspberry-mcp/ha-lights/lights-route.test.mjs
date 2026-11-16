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
