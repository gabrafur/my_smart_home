import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=fs.readFileSync(new URL('../zigbee2mqtt/external_converters/lellki-jz-zb-001-v201.mjs',import.meta.url),'utf8');
function definition() {
 const enumExpose=()=>({withCategory(){return this},withDescription(){return this}});
 const sandbox={exposes:{presets:{enum:enumExpose},access:{STATE_GET:5}},reporting:{bind:async()=>{}},tuya:{modernExtend:{tuyaBase:()=>({base:true}),tuyaOnOff:args=>({onOff:args})}},utils:{getOptions:()=>({})}};
 vm.runInNewContext(source.replace(/^import .*;\n/gm,'').replace('export default','globalThis.definition ='),sandbox);
 return sandbox.definition;
}
test('limits standard startup behavior to the confirmed model and firmware',()=>{
 const d=definition();assert.deepEqual(JSON.parse(JSON.stringify(d.fingerprint)),[{modelID:'JZ-ZB-001',manufacturerName:'LELLKI',applicationVersion:5,softwareBuildID:'2.0.1'}]);
 assert.equal(d.extend[1].onOff.powerOutageMemory,false);assert.equal(d.extend[1].onOff.powerOnBehavior,false);
 assert.doesNotMatch(source,/moesStartUpOnOff|ieeeAddr/);
});
test('reports only actual readback and never writes a read-only firmware attribute',async()=>{
 const d=definition(),tz=d.toZigbee[0];let stored=0,reads=0;
 const endpoint={write:async()=>assert.fail('read-only'),zclCommand:async()=>assert.fail('read-only'),read:async(c,p)=>{assert.equal(c,'genOnOff');assert.equal(p[0],'startUpOnOff');reads++;return {startUpOnOff:stored}}};
 for(const [value,raw] of [['off',0],['on',1]]){stored=raw;const result=await tz.convertSet(endpoint,'power_outage_memory',value,{mapped:{}});assert.equal(result.state.power_outage_memory,value);assert.equal(d.fromZigbee[0].convert(null,{data:{startUpOnOff:raw}}).power_outage_memory,value)}
 const before=reads;for(const value of ['invalid','toggle','restore',null,0])await assert.rejects(tz.convertSet(endpoint,'power_outage_memory',value,{mapped:{}}));assert.equal(reads,before);
 await assert.rejects(tz.convertSet(endpoint,'power_outage_memory','off',{mapped:{}}),/read-only/);
 assert.equal(d.fromZigbee[0].convert(null,{data:{onOff:1}}),undefined);
});
